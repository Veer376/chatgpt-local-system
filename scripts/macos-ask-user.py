#!/usr/bin/env python3
import base64
import json
import mimetypes
import os
import re
import secrets
import select
import sys
import tempfile
from collections.abc import Mapping, Sequence

import objc


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


try:
    import Quartz
    from AppKit import (
        NSApplication,
        NSApplicationActivationPolicyAccessory,
        NSBackingStoreBuffered,
        NSBeep,
        NSColor,
        NSFloatingWindowLevel,
        NSMakeRect,
        NSMakeSize,
        NSMenu,
        NSMenuItem,
        NSModalResponseOK,
        NSOpenPanel,
        NSPanel,
        NSPasteboard,
        NSPasteboardTypeString,
        NSScreen,
        NSViewHeightSizable,
        NSViewWidthSizable,
        NSWindowCollectionBehaviorFullScreenAuxiliary,
        NSWindowCollectionBehaviorMoveToActiveSpace,
        NSWindowStyleMaskBorderless,
        NSWindowStyleMaskClosable,
        NSWindowStyleMaskResizable,
        NSWindowStyleMaskTitled,
    )
    from Foundation import NSData, NSHTTPURLResponse, NSObject, NSTimer
    from WebKit import WKWebView, WKWebViewConfiguration
except Exception:
    emit({"status": "unavailable", "reason": "pyobjc_unavailable"})
    raise SystemExit(0)


WIDTH = 700
MIN_HEIGHT = 260
DEFAULT_HEIGHT = 430
MAX_HEIGHT = 780
COMPACT_WIDTH = 380
COMPACT_HEIGHT = 92
COMPACT_MIN_HEIGHT = 72
COMPACT_MAX_HEIGHT = 140
CORNER_MARGIN = 18
EXPANDED_STYLE_MASK = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
MAX_NATIVE_IMAGE_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 1_250_000
MAX_ATTACHMENTS = 5
HERE = os.path.dirname(os.path.abspath(__file__))
UI_PATH = os.path.join(HERE, "macos-question-ui.html")
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
MEDIA_ID_RE = re.compile(r"^[a-f0-9]{24,64}$")
BYTE_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
LOCAL_MEDIA_SCHEME = "local-system-media"
WKURLSchemeHandler = objc.protocolNamed("WKURLSchemeHandler")
DEBUG = str(os.environ.get("ASK_USER_DEBUG") or "").strip() == "1"


def debug(message):
    if DEBUG:
        print(f"[macos-question] {message}", file=sys.stderr, flush=True)


def session_state():
    raw = Quartz.CGSessionCopyCurrentDictionary() or {}
    return {
        "loginDone": bool(raw.get("kCGSessionLoginDoneKey", False)),
        "onConsole": bool(raw.get("kCGSSessionOnConsoleKey", False)),
        "screenLocked": bool(raw.get("CGSSessionScreenIsLocked", False)),
    }


def ensure_available():
    state = session_state()
    if not state["loginDone"]:
        return {"status": "unavailable", "reason": "login_incomplete"}
    if not state["onConsole"]:
        return {"status": "unavailable", "reason": "not_console_session"}
    if state["screenLocked"]:
        return {"status": "unavailable", "reason": "screen_locked"}
    if not os.path.isfile(UI_PATH):
        return {"status": "unavailable", "reason": "ui_missing"}
    return None


def plain(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, Sequence):
        return [plain(item) for item in value]
    try:
        return str(value)
    except Exception:
        return None


def safe_filename(name, mime_type):
    fallback_ext = ".png" if mime_type == "image/png" else ".webp" if mime_type == "image/webp" else ".jpg"
    raw = os.path.basename(str(name or f"image{fallback_ext}"))
    normalized = SAFE_NAME_RE.sub("-", raw).lstrip(".") or f"image{fallback_ext}"
    return normalized[-120:]


def persist_attachments(items, directory):
    if not isinstance(items, list):
        return []
    target_dir = str(directory or "").strip()
    if not target_dir:
        target_dir = tempfile.mkdtemp(prefix="local-system-interrupt-")
    os.makedirs(target_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(target_dir, 0o700)
    except Exception:
        pass

    output = []
    for item in items[:MAX_ATTACHMENTS]:
        if not isinstance(item, dict):
            continue
        mime_type = str(item.get("mimeType") or "").strip().lower()
        if not mime_type.startswith("image/"):
            raise ValueError("Only image attachments are supported.")
        data = str(item.get("data") or "")
        match = re.match(r"^data:([^;,]+);base64,(.*)$", data, flags=re.DOTALL)
        if not match:
            raise ValueError("The attached image data is invalid.")
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except Exception as error:
            raise ValueError("The attached image could not be decoded.") from error
        if not raw or len(raw) > MAX_ATTACHMENT_BYTES:
            raise ValueError("The attached image is too large after compression.")
        name = safe_filename(item.get("name"), mime_type)
        filename = f"{secrets.token_hex(5)}-{name}"
        path = os.path.join(target_dir, filename)
        with open(path, "xb") as handle:
            handle.write(raw)
        os.chmod(path, 0o600)
        output.append({"path": path, "name": name, "mimeType": mime_type, "bytes": len(raw)})
    return output


def install_edit_menu(app):
    """Give WKWebView and native fields standard Command-X/C/V/A responder actions."""
    main = NSMenu.alloc().initWithTitle_("Local System")
    edit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Edit", None, "")
    edit_menu = NSMenu.alloc().initWithTitle_("Edit")
    for title, action, key in (
        ("Undo", "undo:", "z"),
        ("Redo", "redo:", "Z"),
        ("Cut", "cut:", "x"),
        ("Copy", "copy:", "c"),
        ("Paste", "paste:", "v"),
        ("Select All", "selectAll:", "a"),
    ):
        edit_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, key))
    edit_item.setSubmenu_(edit_menu)
    main.addItem_(edit_item)
    app.setMainMenu_(main)


class LocalMediaSchemeHandler(NSObject, protocols=[WKURLSchemeHandler]):
    def init(self):
        self = objc.super(LocalMediaSchemeHandler, self).init()
        if self is None:
            return None
        self.media = {}
        self.cancelled_tasks = set()
        return self

    @objc.python_method
    def set_media(self, items):
        media = {}
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                media_id = str(item.get("id") or "").strip().lower()
                file_path = str(item.get("path") or "").strip()
                mime_type = str(item.get("mimeType") or "application/octet-stream").strip().lower()
                expected_bytes = item.get("bytes")
                if not MEDIA_ID_RE.match(media_id) or not os.path.isabs(file_path):
                    continue
                try:
                    stat = os.stat(file_path)
                except Exception:
                    continue
                if not os.path.isfile(file_path):
                    continue
                if isinstance(expected_bytes, int) and expected_bytes >= 0 and stat.st_size != expected_bytes:
                    continue
                media[media_id] = {
                    "path": file_path,
                    "mimeType": mime_type,
                    "bytes": stat.st_size,
                }
        self.media = media
        self.cancelled_tasks.clear()

    @objc.python_method
    def _entry_for_task(self, task):
        try:
            url = task.request().URL()
            if str(url.scheme() or "").lower() != LOCAL_MEDIA_SCHEME:
                return None, url
            parts = [part for part in str(url.path() or "").split("/") if part]
            media_id = parts[-1].lower() if parts else ""
            return self.media.get(media_id), url
        except Exception:
            return None, None

    @objc.python_method
    def _range_for_request(self, request, total):
        if total <= 0:
            return 0, -1, 200
        raw = str(request.valueForHTTPHeaderField_("Range") or "").strip()
        if not raw:
            return 0, total - 1, 200
        match = BYTE_RANGE_RE.match(raw)
        if not match:
            return None
        start_raw, end_raw = match.groups()
        if not start_raw and not end_raw:
            return None
        if not start_raw:
            suffix = int(end_raw)
            if suffix <= 0:
                return None
            start = max(0, total - suffix)
            return start, total - 1, 206
        start = int(start_raw)
        if start >= total:
            return None
        end = int(end_raw) if end_raw else total - 1
        end = min(end, total - 1)
        if end < start:
            return None
        return start, end, 206

    @objc.python_method
    def _send_empty(self, task, url, status):
        if url is None:
            return
        response = NSHTTPURLResponse.alloc().initWithURL_statusCode_HTTPVersion_headerFields_(
            url,
            status,
            "HTTP/1.1",
            {"Content-Length": "0", "Cache-Control": "no-store"},
        )
        task.didReceiveResponse_(response)
        task.didFinish()

    def webView_startURLSchemeTask_(self, _web_view, task):
        entry, url = self._entry_for_task(task)
        if not entry:
            self._send_empty(task, url, 404)
            return
        try:
            total = int(entry["bytes"])
            byte_range = self._range_for_request(task.request(), total)
            if byte_range is None:
                self._send_empty(task, url, 416)
                return
            start, end, status = byte_range
            length = max(0, end - start + 1)
            headers = {
                "Content-Type": entry["mimeType"],
                "Content-Length": str(length),
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
            }
            if status == 206:
                headers["Content-Range"] = f"bytes {start}-{end}/{total}"
            response = NSHTTPURLResponse.alloc().initWithURL_statusCode_HTTPVersion_headerFields_(
                url,
                status,
                "HTTP/1.1",
                headers,
            )
            task.didReceiveResponse_(response)
            debug(f"media {entry['mimeType']} {status} bytes={start}-{end}/{total}")
            task_key = id(task)
            with open(entry["path"], "rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0 and task_key not in self.cancelled_tasks:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    task.didReceiveData_(NSData.dataWithBytes_length_(chunk, len(chunk)))
                    remaining -= len(chunk)
            if task_key not in self.cancelled_tasks:
                task.didFinish()
            self.cancelled_tasks.discard(task_key)
        except Exception:
            try:
                self._send_empty(task, url, 500)
            except Exception:
                pass

    def webView_stopURLSchemeTask_(self, _web_view, task):
        self.cancelled_tasks.add(id(task))


class Controller(NSObject):
    def initWithPanel_sessionMode_(self, panel, session_mode):
        self = objc.super(Controller, self).init()
        if self is None:
            return None
        self.panel = panel
        self.session_mode = bool(session_mode)
        self.active_request_id = None
        self.active_payload = None
        self.attachment_dir = None
        self.result = {"status": "dismissed", "reason": "window_closed"}
        self.web_ready = False
        self.pending_show = None
        self.compact_mode = True
        self.request_queue = []
        self.media_scheme_handler = LocalMediaSchemeHandler.alloc().init()
        self._build_webview()
        return self

    @objc.python_method
    def _build_webview(self):
        with open(UI_PATH, "r", encoding="utf-8") as handle:
            html = handle.read()
        configuration = WKWebViewConfiguration.alloc().init()
        configuration.setURLSchemeHandler_forURLScheme_(self.media_scheme_handler, LOCAL_MEDIA_SCHEME)
        controller = configuration.userContentController()
        controller.addScriptMessageHandler_name_(self, "native")
        self.user_content_controller = controller
        bounds = self.panel.contentView().bounds()
        self.web_view = WKWebView.alloc().initWithFrame_configuration_(bounds, configuration)
        self.web_view.setAutoresizingMask_(NSViewWidthSizable | NSViewHeightSizable)
        self.panel.contentView().addSubview_(self.web_view)
        self.web_view.loadHTMLString_baseURL_(html, None)

    @objc.python_method
    def _evaluate(self, expression):
        if not self.web_ready:
            return
        try:
            self.web_view.evaluateJavaScript_completionHandler_(expression, None)
        except Exception:
            pass

    @objc.python_method
    def _show_error(self, message):
        self._evaluate(f"window.__localSystemShowError({json.dumps(str(message))})")

    @objc.python_method
    def _send_show(self):
        if not self.web_ready or not self.pending_show:
            return
        payload = self.pending_show
        self.pending_show = None
        self._evaluate(f"window.__localSystemShow({json.dumps(payload, ensure_ascii=True)})")

    @objc.python_method
    def _notify_queue(self):
        count = (1 if self.active_request_id else 0) + len(self.request_queue)
        if self.active_payload is not None:
            self.active_payload["pendingCount"] = count
        if self.pending_show is not None:
            self.pending_show["pendingCount"] = count
        self._evaluate(f"window.__localSystemQueue({count})")

    @objc.python_method
    def _activate_next_request(self, compact):
        if self.active_request_id is not None or not self.request_queue:
            if self.active_request_id is None:
                self.panel.orderOut_(None)
            return False
        payload = self.request_queue.pop(0)
        payload = dict(payload)
        payload["_compact"] = bool(compact)
        return self.show_request(payload)

    @objc.python_method
    def _resize(self, requested_height):
        try:
            height = float(requested_height)
        except Exception:
            return
        if self.compact_mode:
            height = max(COMPACT_MIN_HEIGHT, min(COMPACT_MAX_HEIGHT, height))
            self._place_top_right(COMPACT_WIDTH, height, animate=True)
            return
        height = max(MIN_HEIGHT, min(MAX_HEIGHT, height))
        screen = self.panel.screen() or NSScreen.mainScreen()
        if screen is not None:
            height = min(height, max(MIN_HEIGHT, float(screen.visibleFrame().size.height) - 100.0))
        old_frame = self.panel.frame()
        old_top = float(old_frame.origin.y + old_frame.size.height)
        self.panel.setContentSize_(NSMakeSize(WIDTH, height))
        new_frame = self.panel.frame()
        if self.panel.isVisible():
            new_frame.origin.y = old_top - new_frame.size.height
            self.panel.setFrame_display_animate_(new_frame, True, False)

    @objc.python_method
    def _place_top_right(self, width, height, animate=False):
        screen = self.panel.screen() or NSScreen.mainScreen()
        if screen is None:
            self.panel.setContentSize_(NSMakeSize(width, height))
            return
        visible = screen.visibleFrame()
        self.panel.setContentSize_(NSMakeSize(width, height))
        frame = self.panel.frame()
        frame.origin.x = float(visible.origin.x + visible.size.width - frame.size.width - CORNER_MARGIN)
        frame.origin.y = float(visible.origin.y + visible.size.height - frame.size.height - CORNER_MARGIN)
        self.panel.setFrame_display_animate_(frame, True, bool(animate))

    @objc.python_method
    def _set_compact_window_chrome(self, compact):
        content_view = self.panel.contentView()
        if compact:
            self.panel.setStyleMask_(NSWindowStyleMaskBorderless)
            self.panel.setOpaque_(False)
            self.panel.setBackgroundColor_(NSColor.clearColor())
            self.panel.setHasShadow_(True)
            try:
                content_view.setWantsLayer_(True)
                content_view.layer().setCornerRadius_(14.0)
                content_view.layer().setMasksToBounds_(True)
            except Exception:
                pass
            return

        self.panel.setStyleMask_(EXPANDED_STYLE_MASK)
        self.panel.setOpaque_(True)
        self.panel.setBackgroundColor_(NSColor.windowBackgroundColor())
        self.panel.setHasShadow_(True)
        try:
            content_view.setWantsLayer_(True)
            content_view.layer().setCornerRadius_(0.0)
            content_view.layer().setMasksToBounds_(False)
        except Exception:
            pass
        try:
            self.panel.setTitlebarAppearsTransparent_(True)
        except Exception:
            pass

    @objc.python_method
    def _expand_request(self):
        if not self.active_request_id or not self.compact_mode:
            return
        self.compact_mode = False
        self._set_compact_window_chrome(False)
        self._place_top_right(WIDTH, DEFAULT_HEIGHT, animate=True)
        self._evaluate("window.__localSystemExpand()")
        self.panel.makeKeyAndOrderFront_(None)
        NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        self.panel.makeFirstResponder_(self.web_view)

    @objc.python_method
    def _copy_text(self, text):
        value = str(text or "")
        if not value:
            return
        pasteboard = NSPasteboard.generalPasteboard()
        pasteboard.clearContents()
        pasteboard.setString_forType_(value, NSPasteboardTypeString)

    @objc.python_method
    def _choose_images(self):
        picker = NSOpenPanel.openPanel()
        picker.setCanChooseFiles_(True)
        picker.setCanChooseDirectories_(False)
        picker.setAllowsMultipleSelection_(True)
        picker.setResolvesAliases_(True)
        try:
            picker.setAllowedFileTypes_(["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "tif", "tiff"])
        except Exception:
            pass
        if picker.runModal() != NSModalResponseOK:
            return
        files = []
        for url in list(picker.URLs() or [])[:MAX_ATTACHMENTS]:
            path = str(url.path() or "")
            if not path or not os.path.isfile(path):
                continue
            try:
                size = os.path.getsize(path)
                if size <= 0 or size > MAX_NATIVE_IMAGE_BYTES:
                    continue
                mime_type = (mimetypes.guess_type(path)[0] or "image/png").lower()
                if not mime_type.startswith("image/"):
                    continue
                with open(path, "rb") as handle:
                    encoded = base64.b64encode(handle.read()).decode("ascii")
                files.append({
                    "name": os.path.basename(path),
                    "mimeType": mime_type,
                    "data": f"data:{mime_type};base64,{encoded}",
                })
            except Exception:
                continue
        if files:
            self._evaluate(f"window.__localSystemAddNativeFiles({json.dumps(files)})")

    @objc.python_method
    def _normalize_submit(self, payload):
        if self.active_request_id is None:
            return None
        if str(payload.get("requestId") or "") != str(self.active_request_id):
            return None
        skip = bool(payload.get("skip", False))
        presentation_only = bool(payload.get("presentationOnly", False))
        content_only = bool(payload.get("contentOnly", False))
        answer = str(payload.get("answer") or "").strip()
        answers = [str(value).strip() for value in payload.get("answers") or [] if str(value).strip()]
        custom = bool(payload.get("custom", False))
        if presentation_only:
            answer = "Continue"
            answers = [answer]
            custom = False
        elif skip:
            answer = "Skipped"
            answers = [answer]
            custom = True
        if not answer:
            return None
        if custom and self.active_payload and self.active_payload.get("allowCustom") is False:
            self._show_error("Choose one of the available options.")
            NSBeep()
            return None
        answer = answer[:4000]
        answers = [value[:4000] for value in answers[:10]] or [answer]

        options = list(self.active_payload.get("options") or []) if self.active_payload else []
        indexes = payload.get("optionIndexes")
        if isinstance(indexes, list):
            indexes = [int(value) for value in indexes if isinstance(value, int) and 0 <= int(value) < len(options)]
        else:
            indexes = []
        option_index = payload.get("optionIndex")
        if not isinstance(option_index, int) or not (0 <= option_index < len(options)):
            option_index = indexes[0] if len(indexes) == 1 else None
        if not custom and not indexes and options:
            inferred = [options.index(value) for value in answers if value in options]
            indexes = list(dict.fromkeys(inferred))
            if option_index is None and len(indexes) == 1:
                option_index = indexes[0]

        try:
            attachments = persist_attachments(payload.get("attachments") or [], self.attachment_dir)
        except ValueError as error:
            self._show_error(str(error))
            return None

        result = {
            "status": "answered",
            "answer": answer,
            "answers": answers,
            "custom": custom,
            "optionIndex": option_index,
            "optionIndexes": indexes or (None if option_index is None else [option_index]),
        }
        if attachments:
            result["attachments"] = attachments
        if skip:
            result["skipped"] = True
        if presentation_only:
            result["presentationOnly"] = True
        if content_only:
            result["contentOnly"] = True
        return result

    @objc.python_method
    def _finish_answer(self, result):
        if self.session_mode:
            request_id = self.active_request_id
            keep_compact = self.compact_mode
            emit({**result, "requestId": request_id})
            self.active_request_id = None
            self.active_payload = None
            self.attachment_dir = None
            if not self._activate_next_request(keep_compact):
                self._evaluate("window.__localSystemWaiting()")
            return
        self.result = result
        NSApplication.sharedApplication().stopModal()

    def userContentController_didReceiveScriptMessage_(self, _controller, message):
        payload = plain(message.body())
        if not isinstance(payload, dict):
            return
        action = str(payload.get("action") or "")
        if action == "ready":
            self.web_ready = True
            self._send_show()
        elif action == "expand":
            self._expand_request()
        elif action == "resize":
            self._resize(payload.get("height"))
        elif action == "copy":
            self._copy_text(payload.get("text"))
        elif action == "chooseImages":
            self._choose_images()
        elif action == "submit":
            result = self._normalize_submit(payload)
            if result:
                self._finish_answer(result)

    @objc.python_method
    def show_request(self, payload):
        request_id = str(payload.get("requestId") or "").strip()
        question = str(payload.get("question") or "").strip()
        if not request_id or not question:
            if self.session_mode:
                emit({"status": "unavailable", "reason": "invalid_request", "requestId": request_id})
            return False

        if self.session_mode and self.active_request_id is not None:
            if request_id == self.active_request_id or any(
                str(item.get("requestId") or "") == request_id for item in self.request_queue
            ):
                return True
            self.request_queue.append(dict(payload))
            self._notify_queue()
            return True

        options = [str(item).strip() for item in payload.get("options") or [] if str(item).strip()]
        raw_sections = payload.get("sections")
        sections = []
        if isinstance(raw_sections, list):
            for section in raw_sections:
                if not isinstance(section, dict):
                    continue
                text = str(section.get("text") or "").rstrip()
                if not text:
                    continue
                sections.append({
                    "label": str(section.get("label") or "Details").strip() or "Details",
                    "text": text,
                    "mono": bool(section.get("mono", False)),
                })

        kind = str(payload.get("kind") or payload.get("interactionKind") or "question").strip().lower()
        kind = "approval" if kind == "approval" or str(payload.get("title") or "").lower() == "approval" else "question"
        allow_custom = True if kind == "question" else bool(payload.get("allowCustom", True))
        self.media_scheme_handler.set_media(payload.get("presentationMedia") or [])
        requested_compact = bool(payload.get("_compact", True))
        self.active_request_id = request_id
        self.compact_mode = requested_compact
        self.attachment_dir = str(payload.get("attachmentDir") or "").strip() or None
        self.active_payload = {
            "requestId": request_id,
            "kind": kind,
            "question": question,
            "title": str(payload.get("title") or ("Approval" if kind == "approval" else "Question")),
            "prompt": str(payload.get("prompt") or "").strip(),
            "sections": sections,
            "options": options,
            "allowCustom": allow_custom,
            "multiple": bool(payload.get("multiSelect", False)),
            "questionIndex": int(payload.get("questionIndex") or 0),
            "questionCount": max(1, int(payload.get("questionCount") or 1)),
            "expiresAt": payload.get("expiresAt"),
            "content": str(payload.get("content") or ""),
            "presentationOnly": bool(payload.get("presentationOnly", False)),
            "contentOnly": bool(payload.get("contentOnly", False)),
            "pendingCount": 1 + len(self.request_queue),
            "compact": requested_compact,
        }
        self.pending_show = self.active_payload
        self._send_show()
        self.panel.setTitle_(f"Local System — {self.active_payload['title']}")
        if requested_compact:
            self._set_compact_window_chrome(True)
            self._place_top_right(COMPACT_WIDTH, COMPACT_HEIGHT, animate=False)
            self.panel.setAlphaValue_(0.0)
            self.panel.orderFrontRegardless()
            try:
                self.panel.animator().setAlphaValue_(1.0)
            except Exception:
                self.panel.setAlphaValue_(1.0)
        else:
            self._set_compact_window_chrome(False)
            self.panel.setAlphaValue_(1.0)
            self.panel.orderFrontRegardless()
        return True

    @objc.python_method
    def cancel_request(self, request_id, keep_open):
        request_id = str(request_id or "")
        if request_id != str(self.active_request_id or ""):
            before = len(self.request_queue)
            self.request_queue = [
                item for item in self.request_queue
                if str(item.get("requestId") or "") != request_id
            ]
            if len(self.request_queue) != before:
                self._notify_queue()
            return
        keep_compact = self.compact_mode
        self.active_request_id = None
        self.active_payload = None
        self.attachment_dir = None
        if self.request_queue and keep_open:
            self._activate_next_request(keep_compact)
        else:
            self._evaluate("window.__localSystemWaiting()")
            self.panel.orderOut_(None)

    def windowShouldClose_(self, _sender):
        if self.active_request_id is not None:
            result = {"status": "dismissed", "reason": "window_closed"}
            if self.session_mode:
                emit({**result, "requestId": self.active_request_id})
                self.active_request_id = None
                self.active_payload = None
                self.attachment_dir = None
                if not self._activate_next_request(True):
                    self.panel.orderOut_(None)
                return False
            self.result = result
            NSApplication.sharedApplication().stopModal()
        return True

    @objc.python_method
    def handle_session_command(self, payload):
        action = str(payload.get("action") or "").strip()
        if action == "show":
            self.show_request(payload)
        elif action == "cancel":
            self.cancel_request(payload.get("requestId"), bool(payload.get("keepOpen", False)))
        elif action == "shutdown":
            self.panel.orderOut_(None)
            NSApplication.sharedApplication().stop_(None)

    def pollInput_(self, _timer):
        while True:
            try:
                ready, _, _ = select.select([sys.stdin], [], [], 0)
            except Exception:
                ready = []
            if not ready:
                return
            line = sys.stdin.readline()
            if line == "":
                self.panel.orderOut_(None)
                NSApplication.sharedApplication().stop_(None)
                return
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if isinstance(payload, dict):
                self.handle_session_command(payload)


def make_panel():
    panel = NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
        NSMakeRect(0, 0, WIDTH, DEFAULT_HEIGHT),
        NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable,
        NSBackingStoreBuffered,
        False,
    )
    panel.setTitle_("Local System")
    panel.setReleasedWhenClosed_(False)
    panel.setHidesOnDeactivate_(False)
    panel.setMinSize_(NSMakeSize(COMPACT_WIDTH, COMPACT_HEIGHT))
    panel.setMaxSize_(NSMakeSize(WIDTH, MAX_HEIGHT + 80))
    panel.setFloatingPanel_(True)
    panel.setLevel_(NSFloatingWindowLevel)
    panel.setBackgroundColor_(NSColor.windowBackgroundColor())
    try:
        panel.setTitlebarAppearsTransparent_(True)
    except Exception:
        pass
    panel.setCollectionBehavior_(
        NSWindowCollectionBehaviorMoveToActiveSpace | NSWindowCollectionBehaviorFullScreenAuxiliary
    )
    panel.center()
    return panel


if "--probe" in sys.argv:
    state = session_state()
    emit({
        "status": "available" if state["loginDone"] and state["onConsole"] and not state["screenLocked"] else "unavailable",
        **state,
    })
    raise SystemExit(0)

unavailable = ensure_available()
if unavailable:
    emit(unavailable)
    raise SystemExit(0)

app = NSApplication.sharedApplication()
app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
install_edit_menu(app)

if "--session" in sys.argv:
    panel = make_panel()
    controller = Controller.alloc().initWithPanel_sessionMode_(panel, True)
    panel.setDelegate_(controller)
    timer = NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
        0.05, controller, "pollInput:", None, True
    )
    app.run()
    timer.invalidate()
    panel.orderOut_(None)
    raise SystemExit(0)

try:
    payload = json.load(sys.stdin)
except Exception:
    emit({"status": "unavailable", "reason": "invalid_request"})
    raise SystemExit(0)

if not isinstance(payload, dict):
    emit({"status": "unavailable", "reason": "invalid_request"})
    raise SystemExit(0)

panel = make_panel()
controller = Controller.alloc().initWithPanel_sessionMode_(panel, False)
panel.setDelegate_(controller)
if not controller.show_request(payload):
    emit({"status": "unavailable", "reason": "invalid_request"})
    raise SystemExit(0)

app.runModalForWindow_(panel)
panel.orderOut_(None)
emit(controller.result)
