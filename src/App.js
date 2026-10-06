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
import ManualBlockGuard from './components/ManualBlockGuard';
import PageTracker from './components/PageTracker';
import AccountBar from './components/AccountBar';
import AdminStatistics from "./pages/AdminStatistics";
import PeopleGapsAdminPage from "./pages/PeopleGapsAdminPage";
import GprReportGapsAdminPage from "./pages/GprReportGapsAdminPage";
import PeopleGapsUsersAdminPage from "./pages/PeopleGapsUsersAdminPage";
import BlockedUsersAdminPage from "./pages/BlockedUsersAdminPage";
import AdminDashboardPage from "./pages/AdminDashboardPage";
import RascenkiReindexAdminPage from "./pages/RascenkiReindexAdminPage";
import ConcreteDashboardPage from "./pages/ConcreteDashboardPage";
import RideAccessGate from "./components/RideAccessGate";
import RideRoleRoute from "./components/RideRoleRoute";
import DriverDashboardPage from "./pages/rides/DriverDashboardPage";
import EmployeeRidesPage from "./pages/rides/EmployeeRidesPage";
import DispatcherRidesPage from "./pages/rides/DispatcherRidesPage";
import RidesAdminPage from "./pages/rides/RidesAdminPage";
import FinancingPlanDashboardPage from "./pages/FinancingPlanDashboardPage";
import FinancingResyncAdminPage from "./pages/FinancingResyncAdminPage";


const Protected = ({ children }) => (
  <PrivateRoute>
    {children}
  </PrivateRoute>
);

const App = () => {
  return (
    <Router>
      <PageTracker />
      <AccountBar />
      <RideAccessGate>
      <Routes>

        {/* Авторизация */}
        <Route path="/login" element={<LoginPage />} />

        {/* Система служебного транспорта (заявки на поездки) */}
        <Route path="/driver" element={<Protected><RideRoleRoute roles={["driver"]}><DriverDashboardPage /></RideRoleRoute></Protected>}/>
        <Route
          path="/employee"
          element={
            <Protected>
              <RideRoleRoute roles={["employee", "dispatcher"]}>
                <EmployeeRidesPage />
              </RideRoleRoute>
            </Protected>
          }
        />
        <Route
          path="/dispatcher"
          element={
            <Protected>
              <RideRoleRoute roles={["dispatcher"]}>
                <DispatcherRidesPage />
              </RideRoleRoute>
            </Protected>
          }
        />
        <Route
          path="/rides-admin"
          element={
            <Protected>
              <RideRoleRoute roles={["dispatcher"]}>
                <RidesAdminPage />
              </RideRoleRoute>
            </Protected>
          }
        />

        {/* Главная */}
        <Route path="/" element={<Protected><HomePage /></Protected>} />

        {/* Заявки */}
        <Route
          path="/request"
          element={
            <Protected>
              <ManualBlockGuard>
                <GprReportGuard>
                  <PeopleGapsGuard>
                    <RequestPage />
                  </PeopleGapsGuard>
                </GprReportGuard>
              </ManualBlockGuard>
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
              <ManualBlockGuard>
                <GprReportGuard>
                  <PeopleGapsGuard>
                    <ConcreteRequestPage />
                  </PeopleGapsGuard>
                </GprReportGuard>
              </ManualBlockGuard>
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
          path="/ai-assistant"
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
          path="/admin/financing-resync"
          element={
            <Protected>
              <AdminRoute>
                <FinancingResyncAdminPage />
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
      </RideAccessGate>
    </Router>
  );
};

export default App;