const reveals = document.querySelectorAll('.reveal');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (reducedMotion || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('is-visible'));
} else {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  reveals.forEach((el) => observer.observe(el));
}

const listingRows = [...document.querySelectorAll('#hero-listing .terminal-row')];
if (!reducedMotion && listingRows.length > 1) {
  let active = 0;
  window.setInterval(() => {
    listingRows[active].classList.remove('is-active');
    active = (active + 1) % listingRows.length;
    listingRows[active].classList.add('is-active');
  }, 1650);
}

for (const button of document.querySelectorAll('[data-copy-target]')) {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      const previous = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => { button.textContent = previous; }, 1300);
    } catch {
      button.textContent = 'Select';
    }
  });
}
