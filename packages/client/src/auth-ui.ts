/** Account UI: register/login/logout modals, session storage, ranked gate. */
import { showModal } from './modal.js';

export interface AuthDeps {
  send: (roomId: string, text: string) => void;
  getName: () => string;
  isGuest: () => boolean;
  onSearchAnyway: () => void;
}

export function getSession(): { name: string; token: string } | null {
  try {
    const raw = JSON.parse(localStorage.getItem('ss-session') ?? 'null');
    if (raw && typeof raw.name === 'string' && typeof raw.token === 'string') return raw;
  } catch { /* corrupt */ }
  return null;
}

export function initAuthUI(deps: AuthDeps): {
  setRegisteredUI: (registered: boolean) => void;
  isRegistered: () => boolean;
  doRegister: () => void;
  maybeShowRankedGate: () => boolean;
} {
  let registered = false;

  function setRegisteredUI(value: boolean): void {
    registered = value;
    document.getElementById('register-btn')!.classList.toggle('hidden', value);
    document.getElementById('login-btn')!.classList.toggle('hidden', value);
    document.getElementById('rename-btn')!.classList.toggle('hidden', value);
    document.getElementById('logout-btn')!.classList.toggle('hidden', !value);
  }

  function doRegister(): void {
    showModal({
      title: 'Register your name',
      bodyHTML: '<p>Registering protects your name and saves your ranked rating.</p>',
      fields: [
        { name: 'name', label: 'Name', value: deps.isGuest() ? '' : deps.getName() },
        { name: 'password', label: 'Password (min 4 chars)', type: 'password' },
      ],
      buttons: [
        {
          label: 'Register',
          primary: true,
          onClick: (v) => {
            if (!v['name'] || (v['password'] ?? '').length < 4) return false;
            deps.send('', `/register ${v['name']},${v['password']}`);
          },
        },
        { label: 'Cancel' },
      ],
    });
  }

  function doLogin(): void {
    showModal({
      title: 'Log in',
      fields: [
        { name: 'name', label: 'Account name' },
        { name: 'password', label: 'Password', type: 'password' },
      ],
      buttons: [
        {
          label: 'Log in',
          primary: true,
          onClick: (v) => {
            if (!v['name'] || !v['password']) return false;
            deps.send('', `/login ${v['name']},${v['password']}`);
          },
        },
        { label: 'Cancel' },
      ],
    });
  }

  function doRename(): void {
    showModal({
      title: 'Choose a username',
      fields: [{ name: 'name', label: 'Name (max 18 characters)', value: deps.getName() }],
      buttons: [
        {
          label: 'OK',
          primary: true,
          onClick: (v) => {
            if (!v['name']) return false;
            deps.send('', `/trn ${v['name']}`);
          },
        },
        { label: 'Cancel' },
      ],
    });
  }

  /** Soft gate before unregistered ranked play. True = gate shown. */
  function maybeShowRankedGate(): boolean {
    if (registered || sessionStorage.getItem('ss-ranked-warned')) return false;
    showModal({
      title: 'Protect your rating!',
      bodyHTML: `<p>You're playing as <b>${deps.getName()}</b> without an account.<br/>
        If you don't register, your ranked progress <b>won't be saved</b> —
        you could lose this name and its rating.</p>`,
      buttons: [
        { label: 'Register (free)', primary: true, onClick: () => { doRegister(); } },
        {
          label: 'Play anyway',
          onClick: () => {
            sessionStorage.setItem('ss-ranked-warned', '1');
            deps.onSearchAnyway();
          },
        },
      ],
    });
    return true;
  }

  document.getElementById('register-btn')!.addEventListener('click', doRegister);
  document.getElementById('login-btn')!.addEventListener('click', doLogin);
  document.getElementById('rename-btn')!.addEventListener('click', doRename);
  document.getElementById('logout-btn')!.addEventListener('click', () => {
    const session = getSession();
    deps.send('', `/logout ${session?.token ?? ''}`);
    setTimeout(() => {
      localStorage.removeItem('ss-session');
      location.reload();
    }, 1500);
  });

  return { setRegisteredUI, isRegistered: () => registered, doRegister, maybeShowRankedGate };
}
