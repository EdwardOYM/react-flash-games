import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { installUiSounds } from './soundEffects'
import App from './App.tsx'

installUiSounds()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
