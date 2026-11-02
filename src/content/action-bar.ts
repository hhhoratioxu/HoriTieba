// The website cannot read the template inside the closed shadow root.
export function mountActionBar(
  id: string,
  title: string,
  placeholder: string,
  lifetime: AbortSignal,
) {
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText =
    'all:initial!important;position:fixed!important;bottom:12px!important;left:50%!important;transform:translateX(-50%)!important;width:min(620px,calc(100vw - 24px))!important;z-index:2147483000!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    * { box-sizing: border-box }
    section { padding: 8px 10px; border: 1px solid #d6dce5; border-radius: 10px; background: white; color: #202c3a; box-shadow: 0 2px 12px #20324621; font: 14px/1.4 system-ui, sans-serif }
    .line { display: flex; align-items: center; gap: 8px }
    label { white-space: nowrap; font-weight: 650 }
    textarea { flex: 1; min-width: 0; height: 34px; max-height: 100px; padding: 6px 9px; border: 1px solid #b7c4d3; border-radius: 6px; font: inherit; resize: vertical }
    :focus-visible { outline: 2px solid #4058ac; outline-offset: 1px }
    button { border: 0; border-radius: 6px; padding: 8px 14px; background: #374fb1; color: white; font: 600 14px system-ui; white-space: nowrap; cursor: pointer }
    button:disabled { background: #e1e5ee; color: #657384; cursor: default }
    .skip { background: #edf1f8; color: #394150 }
    small { display: block; margin-top: 5px; color: #526173; font-size: 12px }
    small:empty, [hidden] { display: none }
    @media (max-width: 480px) { .line { gap: 5px } button { padding: 8px 10px } }
  </style><section><div class="line"><label for="text"></label><textarea id="text" rows="1" maxlength="2000"></textarea><button class="main" disabled>开始</button><button class="skip" hidden>跳过此条</button></div><small role="status" aria-live="polite"></small></section>`;
  const label = shadow.querySelector('label')!;
  const input = shadow.querySelector('textarea')!;
  label.textContent = title;
  shadow.querySelector('section')!.setAttribute('aria-label', 'HoriTieba ' + title);
  input.setAttribute('aria-label', title + '内容');
  input.placeholder = placeholder;
  document.body.append(host);
  lifetime.addEventListener('abort', () => host.remove(), { once: true });
  return {
    input,
    button: shadow.querySelector<HTMLButtonElement>('.main')!,
    skip: shadow.querySelector<HTMLButtonElement>('.skip')!,
    status: shadow.querySelector('small')!,
    focus: () => {
      window.focus();
      input.focus({ preventScroll: true });
    },
  };
}
