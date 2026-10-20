// Synthetic stand-in for the vendored modular firebase-auth.js; the auth object keeps the real Auth's currentUser and signOut().
const read = (key, fallback) => JSON.parse(sessionStorage.getItem(key) || 'null') ?? fallback;
const write = (key, value) => sessionStorage.setItem(key, JSON.stringify(value));
const fail = (code) => Object.assign(Error(code), { code });
const listeners = [];
window.__testEmails = [];
window.__testTokenRequests = [];
// Accounts persist in sessionStorage so reloads keep the synthetic password user. Its uid is the email's local part.
window.__testVerify = (email) => {
  const accounts = read('synthetic-accounts', {});
  accounts[email].verified = true;
  write('synthetic-accounts', accounts);
};
// Accounts the backend created (superadmin owner logins) live on the test server, which checks their
// passwords and serves their current custom claims; their addresses are verified.
const serverAccount = (email) => read('synthetic-server-accounts', []).includes(email);
const passwordUser = (email) => {
  const server = serverAccount(email);
  const verified = () => server || !!read('synthetic-accounts', {})[email]?.verified;
  const user = {
    uid: email.split('@')[0],
    email,
    providerData: [{ providerId: 'password' }],
    emailVerified: verified(),
    getIdToken: async () => user.uid,
    // window.__testStaleClaims stands for a token issued before the backend set the claim.
    getIdTokenResult: async () => ({
      claims:
        server && !window.__testStaleClaims
          ? await (await fetch('/__test/auth/claims?uid=' + encodeURIComponent(user.uid))).json()
          : {},
    }),
    reload: async () => {
      user.emailVerified = verified();
    },
  };
  return user;
};
const initial = () => {
  if (sessionStorage.getItem('synthetic-signed-out')) return null;
  const uid = sessionStorage.getItem('synthetic-uid') || 'test-owner-' + crypto.randomUUID();
  sessionStorage.setItem('synthetic-uid', uid);
  const email = [
    ...Object.keys(read('synthetic-accounts', {})),
    ...read('synthetic-server-accounts', []),
  ].find((address) => address.split('@')[0] === uid);
  return email
    ? passwordUser(email)
    : {
        uid,
        email: 'synthetic@example.invalid',
        emailVerified: true,
        providerData: [{ providerId: 'google.com' }],
        getIdToken: async (force) => {
          window.__testTokenRequests.push(!!force);
          return uid;
        },
      };
};
const change = (user) => {
  auth.currentUser = user;
  if (user) {
    sessionStorage.removeItem('synthetic-signed-out');
    sessionStorage.setItem('synthetic-uid', user.uid);
  } else sessionStorage.setItem('synthetic-signed-out', '1');
  listeners.forEach((fn) => fn(user));
  return { user };
};
const auth = {
  currentUser: initial(),
  signOut: async () => {
    change(null);
  },
};
export const indexedDBLocalPersistence = { type: 'LOCAL' },
  browserLocalPersistence = { type: 'LOCAL' },
  browserPopupRedirectResolver = {};
export const initializeAuth = () => auth;
export const onAuthStateChanged = (target, fn) => {
  listeners.push(fn);
  window.__testAuthChanged = fn;
  fn(target.currentUser);
  return () => {};
};
export class GoogleAuthProvider {
  setCustomParameters() {}
}
export const signInWithPopup = async () => {};
export const signOut = (target) => target.signOut();
export const signInWithEmailAndPassword = async (target, email, password) => {
  const account = read('synthetic-accounts', {})[email];
  if (!account) {
    const response = await fetch('/__test/auth/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw fail('auth/invalid-credential');
    write('synthetic-server-accounts', [
      ...new Set([...read('synthetic-server-accounts', []), email]),
    ]);
    return change(passwordUser(email));
  }
  if (account.password !== password) throw fail('auth/wrong-password');
  return change(passwordUser(email));
};
export const EmailAuthProvider = {
  credential: (email, password) => ({ email, password }),
};
// Like Firebase: checks the password for that user only; it never changes currentUser.
export const reauthenticateWithCredential = async (user, credential) => {
  const response = await fetch('/__test/auth/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credential),
  });
  if (!response.ok || (await response.json()).uid !== user.uid)
    throw fail('auth/invalid-credential');
  return { user };
};
export const sendPasswordResetEmail = async (target, email) => {
  window.__testEmails.push({ type: 'reset', email });
};
export const sendEmailVerification = async (user) => {
  window.__testEmails.push({ type: 'verify', email: user.email });
};
