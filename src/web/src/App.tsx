import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import OrdersPage from './pages/OrdersPage';
import DashboardPage from './pages/DashboardPage';
import SupplierPage from './pages/SupplierPage';
import { LiveStatus } from './components/LiveStatus';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> Order&nbsp;Ops
        </div>
        <nav className="nav">
          <NavLink to="/orders" className={({ isActive }) => (isActive ? 'active' : '')}>
            Orders
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? 'active' : '')}>
            Analytics
          </NavLink>
        </nav>
        <LiveStatus />
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/orders" replace />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/suppliers/:id" element={<SupplierPage />} />
          <Route path="*" element={<div className="card">Not found.</div>} />
        </Routes>
      </main>
    </div>
  );
}
