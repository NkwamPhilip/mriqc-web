import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { AuthProvider } from './context/AuthContext'
import Navbar  from './components/Navbar'
import Footer  from './components/Footer'
import Support from './components/Support'
import Home    from './pages/Home'
import Analyze from './pages/Analyze'
import Compare from './pages/Compare'
import Login          from './pages/Login'
import Register       from './pages/Register'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword  from './pages/ResetPassword'
import MySubmissions  from './pages/MySubmissions'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ScrollToTop />
        <Navbar />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/analyze" element={<Analyze />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/submissions" element={<MySubmissions />} />
        </Routes>
        <Footer />
        {/* Floating support widget — visible on every page */}
        <Support />
      </AuthProvider>
    </BrowserRouter>
  )
}
