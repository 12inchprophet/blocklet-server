/* eslint-disable object-curly-newline */
import { Suspense, lazy, useEffect, useMemo } from 'react';
import { BrowserRouter as Router, Route, Routes, Navigate, useLocation, useParams } from 'react-router-dom';
import CircularProgress from '@mui/material/CircularProgress';
import Center from '@arcblock/ux/lib/Center';
import '@abtnode/util/lib/dayjs';
import { WELLKNOWN_SERVICE_PATH_PREFIX } from '@abtnode/constant';
import { Helmet } from 'react-helmet';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';

import { BLOCKLET_TENANT_MODES } from '@blocklet/constant';
import Root from './components/root';

import { AuthProvider } from './contexts/auth';
import { BlockletProvider } from './contexts/blocklet';
import { NodeProvider } from './contexts/node';
import { NotificationProvider } from './contexts/notification';
import Fallback from './fallback';
import { PREFIX } from './util';

const UserLogin = lazy(() => import('./pages/login'));
const UserLoginOAuthCallback = lazy(() => import('./pages/login-oauth-callback'));
const Connect = lazy(() => import('./pages/connect'));
const ExchangePassport = lazy(() => import('./pages/exchange-passport'));
const IssuePassport = lazy(() => import('./pages/issue-passport'));
const LostPassport = lazy(() => import('./pages/lost-passport'));
const Start = lazy(() => import('./pages/start'));
const Setup = lazy(() => import('./pages/setup'));
const Wizard = lazy(() => import('./pages/wizard'));
const Invite = lazy(() => import('./pages/invite'));
const Transfer = lazy(() => import('./pages/transfer'));
const Dashboard = lazy(() => import('./pages/dashboard'));
const UserCenter = lazy(() => import('./pages/user-center'));
const ProfileEmbed = lazy(() => import('./pages/profile-embed'));
const StudioHome = lazy(() => import('./pages/studio/home'));
const StudioPreferences = lazy(() => import('./pages/studio/preferences'));
const StudioBranding = lazy(() => import('./pages/studio/branding'));
const StudioLocalization = lazy(() => import('./pages/studio/localization'));
const AddResource = lazy(() => import('./pages/add-resource'));
const Publish = lazy(() => import('./pages/publish-resource'));
const NotFoundPage = lazy(() => import('./pages/notfound/index'));
const EmailKyc = lazy(() => import('./pages/kyc/email'));
const OAuthAuthorization = lazy(() => import('./pages/oauth/authorize'));
const Unsubscribe = lazy(() => import('./pages/unsubscribe'));
const OpenWindow = lazy(() => import('./pages/open-window'));
const GenAccessKey = lazy(() => import('./pages/cli/gen-access-key'));
const GenSimpleAccessKey = lazy(() => import('./pages/cli/gen-simple-access-key'));

function DevelopersRedirect() {
  const { tab } = useParams();
  let to = `${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/operations`;
  if (tab) {
    to += `/${tab}`;
  }
  return <Navigate to={to} replace />;
}

export function App() {
  const { t } = useLocaleContext();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);

  useEffect(() => {
    if (window.tracker && typeof window.tracker.pageView === 'function') {
      window.tracker.pageView(`${location.pathname}${location.search}`);
    }
  }, [location]);

  useEffect(() => {
    const embed = searchParams.get('embed');
    if (embed) {
      window.sessionStorage.setItem('embed', embed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seamless = searchParams.has('popup');
  const fallback = <Center>{seamless ? null : <CircularProgress />}</Center>;

  // @FIXME: 部分情况下嵌套的 title 显示不太稳定（需要刷新才显示或刷新后失效）。先隐藏 user center 的 title
  const hideHelmet = useMemo(() => {
    const userCenterPath = `${WELLKNOWN_SERVICE_PATH_PREFIX}/user`;
    return location.pathname.startsWith(userCenterPath);
  }, [location]);

  return (
    <>
      {hideHelmet ? null : (
        <Helmet>
          <title>{t('pageTitle.dashboard')}</title>
        </Helmet>
      )}
      <Suspense fallback={fallback}>
        <Routes>
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/open-window`} element={<OpenWindow />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/lost-passport`} element={<LostPassport />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/issue-passport`} element={<IssuePassport />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/login`} element={<UserLogin />} />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/oauth/callback/:provider`}
            element={<UserLoginOAuthCallback />}
          />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/connect`} element={<Connect />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/exchange-passport`} element={<ExchangePassport />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/invite`} element={<Invite />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/transfer`} element={<Transfer />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/studio`} element={<StudioHome />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/studio/home`} element={<StudioHome />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/studio/preferences`} element={<StudioPreferences />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/studio/branding`} element={<StudioBranding />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/studio/localization`} element={<StudioLocalization />} />

          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/kyc/email`} element={<EmailKyc />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/oauth/authorize`} element={<OAuthAuthorization />} />

          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/gen-access-key`} element={<GenAccessKey />} />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/gen-simple-access-key`} element={<GenSimpleAccessKey />} />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/start`}
            element={
              <AuthProvider>
                <BlockletProvider mode="start">
                  <Start />
                </BlockletProvider>
              </AuthProvider>
            }
          />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/setup/*`}
            element={
              <BlockletProvider mode="setup">
                <Setup />
              </BlockletProvider>
            }
          />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/onboard/*`}
            element={
              <BlockletProvider mode="setup">
                <Wizard />
              </BlockletProvider>
            }
          />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/wizard/*`}
            element={
              <BlockletProvider mode="setup">
                <Wizard />
              </BlockletProvider>
            }
          />
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/user/unsubscribe`} element={<Unsubscribe />} />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/user/profile-embed`}
            element={
              <NodeProvider>
                <AuthProvider roles={['*']}>
                  <NotificationProvider>
                    <ProfileEmbed />
                  </NotificationProvider>
                </AuthProvider>
              </NodeProvider>
            }
          />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/user/orgs/:id`}
            element={
              <NodeProvider>
                <AuthProvider roles={['*']}>
                  <NotificationProvider>
                    <UserCenter tab="orgs" />
                  </NotificationProvider>
                </AuthProvider>
              </NodeProvider>
            }
          />
          {/* 通用的 tab 路由（不支持 ID） */}
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/user/:tab`}
            element={
              <NodeProvider>
                <AuthProvider roles={['*']}>
                  <NotificationProvider>
                    <UserCenter />
                  </NotificationProvider>
                </AuthProvider>
              </NodeProvider>
            }
          />
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/user`}
            element={
              <NodeProvider>
                <AuthProvider roles={['*']}>
                  <NotificationProvider>
                    <UserCenter />
                  </NotificationProvider>
                </AuthProvider>
              </NodeProvider>
            }
          />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/navigation`}
            element={<Navigate to={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/website/navigation`} replace />}
          />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/domains`}
            element={<Navigate to={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/website/domains`} replace />}
          />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/members`}
            element={<Navigate to={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/did-connect/members`} replace />}
          />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/passports`}
            element={<Navigate to={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/did-connect/passports`} replace />}
          />
          {/* developers 与 operations 已合并，兼容旧路由 */}
          <Route path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/developers/:tab?`} element={<DevelopersRedirect />} />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/:app/:tab?/*`}
            element={
              <NodeProvider>
                <NotificationProvider>
                  <AuthProvider roles={['owner', 'admin', 'member']}>
                    <BlockletProvider mode="dashboard">
                      <Dashboard />
                    </BlockletProvider>
                  </AuthProvider>
                </NotificationProvider>
              </NodeProvider>
            }
          />

          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin`}
            element={<Navigate to={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/overview`} replace />}
          />

          {/* for third-party embedding */}
          <Route
            path={`${WELLKNOWN_SERVICE_PATH_PREFIX}/embed/resources/:componentDid/*`}
            element={
              // 未来需要变更为 permission based 的 control
              <NodeProvider>
                <AuthProvider
                  roles={
                    window.blocklet?.tenantMode === BLOCKLET_TENANT_MODES.MULTIPLE
                      ? ['owner', 'admin', 'guest']
                      : ['owner', 'admin']
                  }>
                  <BlockletProvider mode="dashboard">
                    <Routes>
                      <Route path="add" element={<AddResource />} />
                      <Route path="publish/*" element={<Publish />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Routes>
                  </BlockletProvider>
                </AuthProvider>
              </NodeProvider>
            }
          />
          <Route path="*" element={<Fallback />} />
        </Routes>
      </Suspense>
    </>
  );
}

export default function AppWrapper() {
  return (
    <Router basename={PREFIX}>
      <Root>
        <App />
      </Root>
    </Router>
  );
}
