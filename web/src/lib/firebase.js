// Firebase init. Reads config from Vite env (VITE_FIREBASE_*). Until those are set,
// `app`/`db`/`auth` are null and the app runs on mock data (see data.js).
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Shared "unico-operations" project (same as welder/plating). Web config is public-safe;
// access to data is controlled by Firestore security rules + Auth. Attendance data is
// namespaced under att_* collections so it never touches the other apps' data.
const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyCK0M-EfmOp9nh1-ZJcrBqT7c4plNxL2FM',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'unico-operations.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'unico-operations',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'unico-operations.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_SENDER_ID || '367786260524',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:367786260524:web:ae49d5da0ef1a71a9e3989',
};

export const isConfigured = Boolean(cfg.apiKey && cfg.projectId);
export const app = isConfigured ? initializeApp(cfg) : null;
export const db = app ? getFirestore(app) : null;
export const auth = app ? getAuth(app) : null;
