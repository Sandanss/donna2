import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ToastProvider } from '@/components/Toast';
import Layout from '@/components/Layout';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Seniors from '@/pages/Seniors';
import Calls from '@/pages/Calls';
import Reminders from '@/pages/Reminders';
import CallAnalyses from '@/pages/CallAnalyses';
import Caregivers from '@/pages/Caregivers';
import DailyContext from '@/pages/DailyContext';
import PostCallJobs from '@/pages/PostCallJobs';
import ScaleOperations from '@/pages/ScaleOperations';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/seniors" element={<Seniors />} />
                  <Route path="/calls" element={<Calls />} />
                  <Route path="/reminders" element={<Reminders />} />
                  <Route path="/call-analyses" element={<CallAnalyses />} />
                  <Route path="/caregivers" element={<Caregivers />} />
                  <Route path="/daily-context" element={<DailyContext />} />
                  <Route path="/post-call-jobs" element={<PostCallJobs />} />
                  <Route path="/scale-operations" element={<ScaleOperations />} />
                </Routes>
              </Layout>
            </ProtectedRoute>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
