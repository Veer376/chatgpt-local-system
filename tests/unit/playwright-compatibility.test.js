import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

for (const name of ['content.js', 'standalone-workspace.js']) {
  test(`${name}: automation skips extension embeds and ordinary tabs retain them`, () => {
    const source = readFileSync(new URL(`../../extensions/local-system/${name}`, import.meta.url), 'utf8');
    const tail = source.slice(source.indexOf('function extensionUrl(path) {'));
    let depth = 0, end = 0;
    for (let i = tail.indexOf('{'); i < tail.length; i++) {
      if (tail[i] === '{') depth++;
      if (tail[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    let marker = '1';
    const context = {document: {documentElement: {getAttribute: () => marker}},
      chrome: {runtime: {id: 'local-system', getURL: p => 'chrome-extension://local-system/' + p}}};
    vm.createContext(context);
    vm.runInContext(tail.slice(0, end), context);
    for (const page of ['todos.html', 'file-workspace.html', 'viewer.html', 'files.html', 'skills.html'])
      assert.equal(context.extensionUrl(page), '');
    assert.equal(context.extensionUrl('/'), 'chrome-extension://local-system//');
    marker = null;
    assert.equal(context.extensionUrl('todos.html'), 'chrome-extension://local-system/todos.html');
  });
}
