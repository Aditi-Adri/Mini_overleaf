import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import './lib/monacoSetup'
import './index.css'
import App from './App.tsx'

// Google sign-in is entirely optional (see AuthBar.tsx) — without a client
// ID configured, the provider is skipped altogether rather than rendered
// with an invalid/empty id, so the rest of the app is unaffected either way.
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

const app = (
  <StrictMode>
    <App />
  </StrictMode>
)

createRoot(document.getElementById('root')!).render(
  googleClientId ? <GoogleOAuthProvider clientId={googleClientId}>{app}</GoogleOAuthProvider> : app,
)
