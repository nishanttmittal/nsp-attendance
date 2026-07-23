// Auth + roles. Two roles: 'admin' (full) and 'manager' (limited — perms TBD by owner).
// With Firebase Auth, role comes from the user's `users/{uid}` doc. Until configured,
// a local mock sign-in lets you preview both roles. Manager permission set is a stub.
import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { isConfigured, auth, db } from './firebase';

// Admin accounts (Google emails). These always get the admin role; everyone else is a
// manager unless their att_users/{uid} doc says otherwise. Add the owner's Google email here.
export const ADMIN_EMAILS = [
  'nspenterprises24@gmail.com',
];

// Manager sees ONLY: Floor (live dashboard) + Advances (give advances + each worker's outstanding
// balance — NO salary/pay figures). Salary, who's-paid, Problems, Settings stay admin-only.
// (Owner rule 2026-07-23: manager = floor + advances only.)
export const MANAGER_FEATURES = ['dashboard', 'advances'];
export const ALL_FEATURES = ['dashboard', 'advances', 'salary', 'problems', 'settings', 'admin', 'archive'];

export function canSee(role, feature) {
  if (role === 'admin') return true;
  if (role === 'manager') return MANAGER_FEATURES.includes(feature);
  return false; // no role = no access
}

const MOCK_KEY = 'nsp_mock_user';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isConfigured || !auth) {
      const saved = localStorage.getItem(MOCK_KEY);
      setUser(saved ? JSON.parse(saved) : null);
      setLoading(false);
      return;
    }
    // Firebase path
    let unsubDoc = null;
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) { setUser(null); setLoading(false); return; }
      const email = (u.email || '').toLowerCase();
      // role keyed by email (matches other apps). Admins via ADMIN_EMAILS; everyone else must be
      // added to att_users by an admin, else NO access (random Google users are locked out).
      unsubDoc = onSnapshot(doc(db, 'att_users', email), (s) => {
        const role = ADMIN_EMAILS.includes(email) ? 'admin' : (s.data()?.role || null);
        setUser({ uid: u.uid, email: u.email, role });
        setLoading(false);
      });
    });
    return () => { unsub(); if (unsubDoc) unsubDoc(); };
  }, []);

  return { user, loading };
}

// Mock sign-in for previewing before Firebase is wired.
export function mockSignIn(role) {
  const u = { uid: 'mock', email: role + '@nsp.local', role, mock: true };
  localStorage.setItem(MOCK_KEY, JSON.stringify(u));
  window.location.reload();
}
export function signOut() {
  localStorage.removeItem(MOCK_KEY);
  if (isConfigured && auth) auth.signOut();
  else window.location.reload();
}
