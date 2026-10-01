import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

import HomePage from './HomePage';
import RequestPage from './RequestPage';
import ElectricansRequestPage from './ElectricansRequestPage';
import GeoRequestPage from './GeoRequestPage';
import PeopleReportPage from './PeopleReportPage';
import ReportsDashboardPage from './ReportsDashboardPage';
import PeopleDashboardPage from './PeopleDashboardPage';
import EquipmentReportPage from './EquipmentReportPage';
import PeopleReportCharts from './PeopleReportCharts';
import ConcreteProductionReport from './ConcreteProductionReport';
import ConcreteDailyReportPage from './ConcreteDailyReportPage';
import ConcreteRequestPage from './ConcreteRequestPage';
import ConcreteChatPage from './pages/ConcreteChatPage';
// ВРЕМЕННО: публичная (без авторизации) страница для тестирования поиска по
// расценкам — маршрут /rascenki-test ниже. Удалить вместе с маршрутом и
// src/pages/RascenkiSearchTestPage.jsx после тестирования.
import RascenkiSearchTestPage from './pages/RascenkiSearchTestPage';
import BLBRequestPage from './BLBRequestPage';
import ZnbRequestPage from './ZnbRequestPage';
import LabTestRequestPaje from "./LabTestRequestPaje";
import DefectActPage from "./pages/DefectActPage";
import GrafikiPage from "./pages/GrafikiPage";
import RemarksPage from "./remarks/RemarksPage";

import SmartRequestPage from './SmartRequestPage';
import LoginPage from './LoginPage';
import PrivateRoute from './components/PrivateRoute';
import AdminRoute from './components/AdminRoute';
import FinancingRoute from './components/FinancingRoute';
import PeopleGapsGuard from './components/PeopleGapsGuard';
import GprReportGuard from './components/GprReportGuard';
import PageTracker from './components/PageTracker';
import AdminStatistics from "./pages/AdminStatistics";
import PeopleGapsAdminPage from "./pages/PeopleGapsAdminPage";
import GprReportGapsAdminPage from "./pages/GprReportGapsAdminPage";
import PeopleGapsUsersAdminPage from "./pages/PeopleGapsUsersAdminPage";
import BlockedUsersAdminPage from "./pages/BlockedUsersAdminPage";
import AdminDashboardPage from "./pages/AdminDashboardPage";
import RascenkiReindexAdminPage from "./pages/RascenkiReindexAdminPage";
import ConcreteDashboardPage from "./pages/ConcreteDashboardPage";
import FinancingPlanDashboardPage from "./pages/FinancingPlanDashboardPage";


const Protected = ({ children }) => (
  <PrivateRoute>
    {children}
  </PrivateRoute>
);

const App = () => {
  return (
    <Router>
      <PageTracker />
      <Routes>

        {/* Авторизация */}
        <Route path="/login" element={<LoginPage />} />

        {/* ВРЕМЕННО: публичный тест поиска по расценкам, без <Protected>.
            Удалить после тестирования (см. RascenkiSearchTestPage.jsx). */}
        <Route path="/rascenki-test" element={<RascenkiSearchTestPage />} />

        {/* Главная */}
        <Route path="/" element={<Protected><HomePage /></Protected>} />

        {/* Заявки */}
        <Route
          path="/request"
          element={
            <Protected>
              <GprReportGuard>
                <PeopleGapsGuard>
                  <RequestPage />
                </PeopleGapsGuard>
              </GprReportGuard>
            </Protected>
          }
        />

        <Route
          path="/electricans-request"
          element={
            <Protected>
              <ElectricansRequestPage />
            </Protected>
          }
        />

        <Route
          path="/geo-request"
          element={
            <Protected>
              <GeoRequestPage />
            </Protected>
          }
        />

        <Route
          path="/concrete-request"
          element={
            <Protected>
              <GprReportGuard>
                <PeopleGapsGuard>
                  <ConcreteRequestPage />
                </PeopleGapsGuard>
              </GprReportGuard>
            </Protected>
          }
        />

        <Route
          path="/blbrequest"
          element={
            <Protected>
              <BLBRequestPage />
            </Protected>
          }
        />

        <Route
          path="/znbrequest"
          element={
            <Protected>
              <ZnbRequestPage />
            </Protected>
          }
        />

        <Route
          path="/lab-request"
          element={
            <Protected>
              <LabTestRequestPaje />
            </Protected>
          }
        />

        {/* Отчёты */}
        <Route
          path="/people-report"
          element={
            <Protected>
              <PeopleReportPage />
            </Protected>
          }
        />

        <Route
          path="/reports-dashboard"
          element={
            <Protected>
              <ReportsDashboardPage />
            </Protected>
          }
        />

        <Route
          path="/people-dashboard"
          element={
            <Protected>
              <PeopleDashboardPage />
            </Protected>
          }
        />

        <Route
          path="/equipment-report"
          element={
            <Protected>
              <EquipmentReportPage />
            </Protected>
          }
        />

        <Route path="/people-charts" element={<Protected><PeopleReportCharts /></Protected>}/>

        <Route
          path="/concrete-report"
          element={
            <Protected>
              <ConcreteProductionReport />
            </Protected>
          }
        />

        <Route
          path="/concrete-daily-report"
          element={
            <Protected>
              <ConcreteDailyReportPage />
            </Protected>
          }
        />

        <Route
          path="/concrete-chat"
          element={
            <Protected>
              <ConcreteChatPage />
            </Protected>
          }
        />

        <Route
          path="/concrete-dashboard"
          element={
            <Protected>
              <ConcreteDashboardPage />
            </Protected>
          }
        />

        <Route
          path="/financing-plan"
          element={
            <FinancingRoute>
              <FinancingPlanDashboardPage />
            </FinancingRoute>
          }
        />

        {/* Прочее */}
        <Route
          path="/remarks"
          element={
            <Protected>
              <RemarksPage />
            </Protected>
          }
        />
        <Route
          path="/def-act"
          element={
            <Protected>
              <DefectActPage />
            </Protected>
          }
        />
        <Route
          path="/grafiki"
          element={
            <Protected>
              <GrafikiPage />
            </Protected>
          }
        />
        <Route
          path="/admin"
          element={
            <Protected>
              <AdminRoute>
                <AdminDashboardPage />
              </AdminRoute>
            </Protected>
          }
        />
        <Route
          path="/admin/statistics"
          element={
            <Protected>
              <AdminStatistics />
            </Protected>
          }
        />
        <Route
          path="/admin/people-gaps"
          element={
            <Protected>
              <AdminRoute>
                <PeopleGapsAdminPage />
              </AdminRoute>
            </Protected>
          }
        />
        <Route
          path="/admin/gpr-report-gaps"
          element={
            <Protected>
              <AdminRoute>
                <GprReportGapsAdminPage />
              </AdminRoute>
            </Protected>
          }
        />
        <Route
          path="/admin/users"
          element={
            <Protected>
              <AdminRoute>
                <PeopleGapsUsersAdminPage />
              </AdminRoute>
            </Protected>
          }
        />
        <Route
          path="/admin/blocked-users"
          element={
            <Protected>
              <AdminRoute>
                <BlockedUsersAdminPage />
              </AdminRoute>
            </Protected>
          }
        />
        <Route
          path="/admin/rascenki"
          element={
            <Protected>
              <AdminRoute>
                <RascenkiReindexAdminPage />
              </AdminRoute>
            </Protected>
          }
        />
        <Route
          path="/smart-request"
          element={
            <Protected>
              <SmartRequestPage />
            </Protected>
          }
        />
      </Routes>
    </Router>
  );
};

export default App;