/* eslint-disable react/jsx-one-expression-per-line */
import React, { useEffect, useCallback } from 'react';
import { EVENTS, WELLKNOWN_BLOCKLET_ADMIN_PATH, WELLKNOWN_SERVICE_PATH_PREFIX } from '@abtnode/constant';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import Center from '@arcblock/ux/lib/Center';
import styled from '@emotion/styled';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import { useCreation } from 'ahooks';
import { joinURL, withQuery } from 'ufo';

import { DeletingBlockletProvider } from '@abtnode/ux/lib/contexts/deleting-blocklets';
import BlockletMigration from '@abtnode/ux/lib/blocklet/migration';
import { useSessionContext } from '@abtnode/ux/lib/contexts/session';
import useSnackbar from '@abtnode/ux/lib/hooks/use-snackbar';
import NotificationComponent from '@abtnode/ux/lib/notifications/notification';
import NotificationContent from '@abtnode/ux/lib/notifications/pages/content';

import AdminLayout from '../components/layout/admin';
import ResumeTip from '../components/resume-tip';
import { useBlockletContext } from '../contexts/blocklet';
import { TeamProvider } from '../contexts/team';
import getWsClient, { useSubscription } from '../libs/ws';

// Service Registry
import Overview from './dashboard/services/overview';
import Observability from './dashboard/services/observability';
import Integrations from './dashboard/services/integrations';
import DidConnect from './dashboard/services/did-connect';
import Website from './dashboard/services/website';
import Notification from './dashboard/services/notification';
import Aigne from './dashboard/services/aigne';
import DidSpaces from './dashboard/services/did-spaces';
import BlockletStudio from './dashboard/services/blocklet-studio';

// Service Registry Map
const SERVICE_REGISTRY = new Map([
  ['overview', Overview],
  ['operations', Observability],
  ['integrations', Integrations],
  ['did-connect', DidConnect],
  ['website', Website],
  ['notification', Notification],
  ['aigne', Aigne],
  ['did-spaces', DidSpaces],
  ['publish', BlockletStudio],
]);

const viewAllUrl = joinURL(WELLKNOWN_SERVICE_PATH_PREFIX, 'user', 'notifications');

const useNotificationSubscription = (userDid) => {
  const { enqueueSnackbar } = useSnackbar();

  const getNotificationLink = useCallback((notification) => {
    return withQuery(viewAllUrl, {
      id: notification.id,
      severity: notification.severity || 'all',
      componentDid: notification.source === 'system' ? 'system' : notification.componentDid || 'all',
    });
  }, []);

  useSubscription(
    `${userDid}/${EVENTS.NOTIFICATION_BLOCKLET_CREATE}`,
    (notification) => {
      const link = getNotificationLink(notification);
      const { severity, description } = notification || {};
      const disableAutoHide = ['error', 'warning'].includes(severity) || notification.sticky;
      // 只通知系统消息
      // 这里不需要单独判断 role，只有 admin owner 才能访问 dashboard 才能接收到 system 来源的消息
      if (notification.source === 'system') {
        enqueueSnackbar(description, {
          variant: severity,
          autoHideDuration: disableAutoHide ? null : 5000,
          anchorOrigin: {
            vertical: 'top',
            horizontal: 'center',
          },
          // eslint-disable-next-line react/no-unstable-nested-components
          content: (key) => (
            <NotificationComponent
              viewAllUrl={link}
              keyId={key}
              notification={notification}
              content={<NotificationContent notification={notification} minimal rows={0} />}
            />
          ),
        });
      }
    },
    [],
    'user'
  );
};

function Dashboard() {
  const { t } = useLocaleContext();
  const navigate = useNavigate();
  const { app = 'overview', tab } = useParams();

  const { blocklet, refreshFlag } = useBlockletContext();
  const { session } = useSessionContext();
  const userDid = useCreation(() => session?.user?.did, [session]);

  useNotificationSubscription(userDid);

  // 获取当前 Service 组件
  const ServiceComponent = SERVICE_REGISTRY.get(app);

  const appPath = useCreation(() => joinURL(WELLKNOWN_BLOCKLET_ADMIN_PATH, app), [app]);

  const domains = useCreation(() => {
    return (blocklet?.site?.domainAliases || []).map((domain) => domain.value);
  }, [blocklet]);

  const isValidAppUrl = useCreation(() => {
    if (!blocklet) return true;

    try {
      const appUrl = blocklet.configs?.find((x) => x.key === 'BLOCKLET_APP_URL')?.value;

      if (!appUrl || !domains.length) return true;

      const { host } = new URL(appUrl);

      return domains.some((domain) => domain === host);
    } catch (error) {
      return false;
    }
  }, [blocklet, domains]);

  const onTabChange = useCallback(
    (newTab) => {
      navigate(`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/${app}/${newTab}`);
    },
    [navigate, app]
  );

  if (!ServiceComponent) {
    return <Navigate to={`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/overview`} replace />;
  }

  const content = !blocklet ? (
    <Center relative="parent">
      <CircularProgress />
    </Center>
  ) : (
    <DeletingBlockletProvider type="components">
      <ServiceComponent />
    </DeletingBlockletProvider>
  );

  return (
    <TeamProvider>
      <AdminLayout key={`${refreshFlag}`} appPath={appPath} appTab={tab} onAppTabChange={onTabChange}>
        <Main>
          {!isValidAppUrl && (
            <Alert
              severity="warning"
              sx={{ mb: 2, py: 2 }}
              action={
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Button
                    size="small"
                    onClick={() => {
                      navigate(`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/website/branding`);
                    }}>
                    {t('invalidAppUrl.viewConfig')}
                  </Button>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={() => {
                      navigate(`${WELLKNOWN_SERVICE_PATH_PREFIX}/admin/website/domains`);
                    }}>
                    {t('invalidAppUrl.viewDomains')}
                  </Button>
                </Box>
              }>
              {t('invalidAppUrl.desc')}
            </Alert>
          )}
          <BlockletMigration />
          <ResumeTip />
          {content}
        </Main>
      </AdminLayout>
    </TeamProvider>
  );
}

export default function WrapDashboard() {
  const { blocklet } = useBlockletContext();

  const did = blocklet?.meta?.did;

  useEffect(() => {
    const wsClient = getWsClient();

    if (did) {
      wsClient.connect();
    }

    return () => {
      if (did && wsClient.isConnected()) {
        wsClient.disconnect();
      }
    };
  }, [did]);

  return <Dashboard />;
}

const Main = styled.main`
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }

  .page-title {
    display: flex;
    align-items: center;

    .page-link {
      font-size: 15px;
      margin-top: 8px;
      margin-left: 8px;
    }
  }

  @media (max-width: ${(props) => props.theme.breakpoints.values.md}px) {
    .page-header {
      flex-direction: column;
      align-items: flex-start;
      .page-actions,
      .MuiButtonGroup-root {
        width: 100%;
      }
      .MuiButtonGroup-root {
        .MuiButtonBase-root {
          flex: 1;
        }
        .blocklet-action-text {
          display: none;
        }
      }
    }

    .page-title {
      margin-bottom: 15px;
    }
  }
`;
