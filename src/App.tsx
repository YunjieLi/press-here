import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import PressHere from './pages/PressHere'

export default function App() {
  return (
    <BrowserRouter basename="/press-here">
      <Routes>
        <Route path="/" element={<Navigate to="/ch1" replace />} />
        <Route path="/ch:n" element={<PressHere />} />
        <Route path="*" element={<Navigate to="/ch1" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
