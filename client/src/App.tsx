import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Pricing from "./pages/Pricing";
import Dashboard from "./pages/Dashboard";
import Account from "./pages/Account";
import OAuthConsent from "./pages/OAuthConsent";
import ExtensionPage from "./extension/ExtensionPage";
import ExtensionConnect from "./extension/ExtensionConnect";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/pricing" element={<Pricing />} />

          {/* OAuth consent: user must be logged in */}
          <Route
            path="/oauth/consent"
            element={<OAuthConsent />}
          />

          {/* Chrome extension: approving a browser (signs in first, like the consent page) */}
          <Route path="/extension/connect" element={<ExtensionConnect />} />

          {/* Protected routes */}
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/extension"
            element={
              <ProtectedRoute>
                <ExtensionPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/account"
            element={
              <ProtectedRoute>
                <Account />
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
