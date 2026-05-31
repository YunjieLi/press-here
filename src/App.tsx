import { BrowserRouter, Routes, Route } from 'react-router-dom'
import PressHere from './pages/PressHere'

export default function App() {
  return (
    <BrowserRouter basename="/press-here">
      <Routes>
        <Route path="/*" element={<PressHere />} />
      </Routes>
    </BrowserRouter>
  )
}
