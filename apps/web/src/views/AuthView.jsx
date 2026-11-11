import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

// B1: Google-only auth — email/password sign-in was removed by product decision.
export default function AuthView() {
  const { signInWithGoogle } = useAuth();
  const [error, setError] = useState(null);

  async function google() {
    setError(null);
    const { error } = await signInWithGoogle();
    if (error) setError(error.message);
  }

  return (
    <div className="centered">
      <div className="card-narrow">
        <div className="wordmark" style={{ fontSize: 24, marginBottom: 6 }}>
          Career<span>OS</span>
        </div>
        <div className="view-sub" style={{ marginBottom: 22 }}>
          Sign in to your case file.
        </div>

        {error && <div className="error-text">{error}</div>}

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={google}>
          Continue with Google
        </button>
      </div>
    </div>
  );
}
