import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MeProvider, useMe } from './context/MeContext';
import Layout from './components/Layout';
import Spinner from './components/Spinner';
import AuthView from './views/AuthView';
import OnboardingView from './views/OnboardingView';
import DashboardView from './views/DashboardView';
import JobDetailView from './views/JobDetailView';
import ManualEntryView from './views/ManualEntryView';
import SettingsView from './views/SettingsView';
import BuyCosView from './views/BuyCosView';
import TrackerView from './views/TrackerView';
import CopilotView from './copilot/CopilotView';

function FullScreenSpinner() {
  return (
    <div className="centered">
      <Spinner />
    </div>
  );
}

// Authenticated shell: waits for /api/me, then routes first-run users (no active
// résumé) to onboarding before anything else.
function AppShell() {
  const { me, loading, error } = useMe();

  if (loading) return <FullScreenSpinner />;
  if (error) {
    return (
      <div className="centered">
        <div className="card-narrow">
          <div className="error-text">Couldn&apos;t reach the CareerOS API: {error}</div>
          <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={() => location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const onboarded = me?.has_active_resume;

  return (
    <Routes>
      <Route path="/onboarding" element={onboarded ? <Navigate to="/" replace /> : <OnboardingView />} />
      {!onboarded ? (
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      ) : (
        <>
          {/* Outside <Layout> — the split-screen Workbench+Canvas needs full
             viewport width, not the shared shell's 1180px-capped main. */}
          <Route path="/copilot/:sessionId" element={<CopilotView />} />
          <Route element={<Layout />}>
            <Route path="/" element={<DashboardView />} />
            <Route path="/manual" element={<ManualEntryView />} />
            <Route path="/scan/:scanId/job/:jobId" element={<JobDetailView />} />
            <Route path="/job/:jobId" element={<JobDetailView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/buy-cos" element={<BuyCosView />} />
            <Route path="/tracker" element={<TrackerView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </>
      )}
    </Routes>
  );
}

// Top-level auth gate.
function Root() {
  const { session, loading } = useAuth();
  if (loading) return <FullScreenSpinner />;
  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<AuthView />} />
      </Routes>
    );
  }
  return (
    <MeProvider>
      <AppShell />
    </MeProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </BrowserRouter>
  );
}
