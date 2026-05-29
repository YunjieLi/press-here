import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import PressHere from './pages/PressHere'

export default function App() {
  return (
    <BrowserRouter basename="/press-here">
      <Routes>
        <Route path="/" element={<PressHere />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
