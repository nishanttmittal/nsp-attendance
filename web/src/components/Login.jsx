import { useState } from 'react';
import { isConfigured, auth } from '../lib/firebase';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { mockSignIn } from '../lib/auth';

export default function Login() {
  const [err, setErr] = useState('');

  async function google() {
    setErr('');
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <div className="w-full max-w-sm bg-white rounded-xl shadow p-6 text-center">
        <img src={`${import.meta.env.BASE_URL}unico-logo.png`} alt="UNICO" className="h-14 mx-auto mb-3 object-contain" />
        <h1 className="text-xl font-bold text-red-700">NSP Attendance</h1>
        <p className="text-sm text-gray-500 mb-5">Sign in to continue</p>

        {isConfigured ? (
          <>
            <button onClick={google} className="w-full border border-gray-300 rounded-lg py-2.5 font-medium flex items-center justify-center gap-2 hover:bg-gray-50">
              <span className="text-lg">G</span> Sign in with Google
            </button>
            {err && <p className="text-sm text-red-600 mt-3">{err}</p>}
            <p className="text-xs text-gray-400 mt-4">Use the Google account your admin set up.</p>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">Preview mode — pick a role.</p>
            <button onClick={() => mockSignIn('admin')} className="w-full bg-red-700 text-white rounded py-2 font-medium">Preview as Admin</button>
            <button onClick={() => mockSignIn('manager')} className="w-full bg-gray-200 text-gray-800 rounded py-2 font-medium">Preview as Manager</button>
          </div>
        )}
      </div>
    </div>
  );
}
