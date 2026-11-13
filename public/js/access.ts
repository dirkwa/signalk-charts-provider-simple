// What the signed-in user may change. The server enforces it; this only
// greys out what would be refused, so every feature stays visible.
// A control that changes something carries data-needs="readwrite" or
// data-needs="admin".

type AccessLevel = 'none' | 'readonly' | 'readwrite' | 'admin';

const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, readonly: 1, readwrite: 2, admin: 3 };
const BLOCKED_EVENTS = ['click', 'change', 'submit', 'dragstart', 'drop'];

let accessLevel: AccessLevel = 'admin';

interface ServerLoginStatus {
  status?: string;
  userLevel?: string;
  authenticationRequired?: boolean;
  readOnlyAccess?: boolean;
}

function accessLevelOf(login: ServerLoginStatus): AccessLevel {
  if (login.authenticationRequired !== true) {
    return 'admin';
  }
  if (login.status === 'loggedIn') {
    const level = login.userLevel;
    return level === 'admin' || level === 'readwrite' || level === 'readonly' ? level : 'none';
  }
  return login.readOnlyAccess === true ? 'readonly' : 'none';
}

function canChange(needs: 'readwrite' | 'admin'): boolean {
  return ACCESS_RANK[accessLevel] >= ACCESS_RANK[needs];
}

function blockedControl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const control = target.closest<HTMLElement>('[data-needs]');
  return control && !canChange(control.dataset['needs'] === 'admin' ? 'admin' : 'readwrite') ? control : null;
}

function showAccessBanner(): void {
  if (accessLevel === 'admin') {
    return;
  }
  const text =
    accessLevel === 'readwrite'
      ? 'Removing, renaming, moving and switching charts on or off needs an administrator.'
      : 'Read only: you can look at everything but not change it. Sign in with read/write access to add and convert charts, or as an administrator to manage them.';
  const banner = document.createElement('div');
  banner.className = 'access-banner';
  banner.textContent = `${text} `;
  const signIn = document.createElement('a');
  signIn.href = '/admin/#/login';
  signIn.textContent = 'Sign in';
  banner.appendChild(signIn);
  document.querySelector('.container')?.prepend(banner);
}

document.addEventListener(
  'keydown',
  (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && blockedControl(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true
);

for (const type of BLOCKED_EVENTS) {
  document.addEventListener(
    type,
    (event) => {
      if (blockedControl(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
}

async function loadAccessLevel(): Promise<void> {
  try {
    const response = await fetch('/skServer/loginStatus', { credentials: 'same-origin' });
    if (!response.ok) {
      return;
    }
    accessLevel = accessLevelOf((await response.json()) as ServerLoginStatus);
  } catch {
    return;
  }
  document.body.dataset['access'] = accessLevel;
  showAccessBanner();
}

window.canChange = canChange;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void loadAccessLevel());
} else {
  void loadAccessLevel();
}
