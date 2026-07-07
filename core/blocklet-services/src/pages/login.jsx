/* eslint-disable react/jsx-one-expression-per-line */
import { useCreation, useLatest, useMemoizedFn, useMount } from 'ahooks';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet';
import { joinURL, withQuery } from 'ufo';
import { Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import Center from '@arcblock/ux/lib/Center';
import useBrowser from '@arcblock/react-hooks/lib/useBrowser';
import Toast from '@arcblock/ux/lib/Toast';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import { getMaster, getFederatedEnabled } from '@arcblock/ux/lib/Util/federated';
import usePassportId from '@abtnode/ux/lib/hooks/use-passport-id';
import { setVisitorId, getVisitorId } from '@arcblock/ux/lib/Util';
import { DEBOS_BLOCKLET_DID, WELLKNOWN_SERVICE_PATH_PREFIX } from '@abtnode/constant';
import { API_DID_PREFIX } from '@arcblock/did-connect-react/lib/constant';
import { updateConnectedInfo, encodeConnectUrl, getAppId } from '@arcblock/did-connect-react/lib/utils';
import bridge from '@arcblock/bridge';
import isUndefined from 'lodash/isUndefined';
import { useSecurity } from '@arcblock/did-connect-react/lib/Connect';
import isNil from 'lodash/isNil';
import getSafeUrlWithToast from '@abtnode/ux/lib/util/get-safe-url';
import { sleep } from '@abtnode/ux/lib/util';
import { debug } from '../libs/logger';
import { useSessionContext } from '../contexts/session';
import { setSessionToken, setRefreshToken, setCsrfToken } from '../util';
import { PassportPaywall } from '../components/paywall';

const getRelativeRedirect = (redirect) => {
  if (!redirect) {
    return '/';
  }

  try {
    const url = new URL(redirect, window.location.origin);
    if (url.origin !== window.location.origin) {
      return '/';
    }
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return '/';
  }
};

export default function UserLogin() {
  const containerRef = useRef(null);
  const { session } = useSessionContext();
  const { t, locale } = useLocaleContext();
  const { getPassportId } = usePassportId();
  const navigate = useNavigate();
  const visitorId = getVisitorId();
  const browser = useBrowser();
  const { encryptKey, decrypt: _decrypt } = useSecurity();
  const latestSession = useLatest(session);

  const { searchParams } = new URL(window.location.href);

  const extraParams = { passportId: getPassportId() };
  const componentId = searchParams.get('componentId');
  const authenticated = searchParams.get('authenticated');
  const sessionToken = searchParams.get('sessionToken');
  const csrfToken = searchParams.get('csrfToken');
  const refreshToken = searchParams.get('refreshToken');
  const requiredRoles = searchParams.get('requiredRoles');
  const redirect = searchParams.get('redirect');
  const forceConnected = searchParams.get('forceConnected');
  const sourceAppPid = searchParams.get('sourceAppPid');
  const origin = searchParams.get('origin');
  const autoConnectWebview = searchParams.get('autoConnectWebview');
  const popup = searchParams.get('popup');
  const showQuickConnect = searchParams.get('showQuickConnect');
  const debosGoogleGrant = searchParams.get('debosGoogleGrant');
  const isDebosInstance =
    [
      window?.blocklet?.componentId,
      window?.blocklet?.componentDid,
      window?.env?.componentId,
      window?.blocklet?.meta?.did,
      window?.blocklet?.appPid,
    ]
      .filter(Boolean)
      .some((value) => String(value).split('/').includes(DEBOS_BLOCKLET_DID)) ||
    window?.env?.did === DEBOS_BLOCKLET_DID;
  const debosGoogleBrokerUrl = window?.env?.debosGoogleLogin?.brokerUrl;
  const canUseDebosGoogleLogin =
    isDebosInstance && debosGoogleBrokerUrl && !forceConnected && !authenticated && !popup && !sessionToken;

  let inviter = searchParams.get('inviter');
  if (!inviter && redirect) {
    try {
      // Handle both absolute URLs and paths
      const redirectUrl = redirect.startsWith('http') ? new URL(redirect) : new URL(redirect, window.location.origin);
      inviter = redirectUrl.searchParams.get('inviter');
    } catch {
      // Ignore URL parsing errors
    }
  }
  inviter = inviter || localStorage.getItem('inviter');

  if (componentId) {
    extraParams.componentId = componentId;
  }
  if (visitorId) {
    extraParams.visitorId = visitorId;
  }
  if (inviter) {
    extraParams.inviter = inviter;
  }
  if (!isUndefined(sourceAppPid)) {
    if (sourceAppPid === 'null') {
      extraParams.sourceAppPid = null;
    } else if (sourceAppPid !== null) {
      extraParams.sourceAppPid = sourceAppPid;
    }
  }
  let parsedRequiredRoles = [];

  try {
    parsedRequiredRoles = JSON.parse(requiredRoles);
  } catch {
    /* empty */
  }

  const notifyWallet = async (data) => {
    const fromWallet = searchParams.get('fromWallet');
    debug('login page notifyWallet', { data, fromWallet, 'browser.wallet': browser.wallet });
    if (data && String(fromWallet) === '1' && browser.wallet) {
      // NOTICE: 最多等待 3 秒，防止用户一直卡在登录页面中
      await Promise.any([bridge.asyncCall('arcSetToken', data), sleep(3000)]);
    }
  };

  const decrypt = (value) => {
    if (!value) {
      return value;
    }

    if (searchParams.get('encrypted')) {
      return _decrypt(value);
    }
    return value;
  };

  const redirectAfterLogin = async (result) => {
    // 登录成功之后向钱包发一个通知
    if (result) {
      await notifyWallet(result);
    }
    setTimeout(() => {
      if (redirect) {
        const url = decodeURIComponent(redirect);
        if (url.startsWith(WELLKNOWN_SERVICE_PATH_PREFIX)) {
          navigate(url, { replace: true });
        } else {
          // 登录后只允许跳回本站的域名，严格限制 allowDomains
          window.location.replace(getSafeUrlWithToast(url));
        }
      } else {
        window.location.replace(window.env.pathPrefix || '/');
      }
    }, 50);
  };

  const notifyBridge = (sessionState) => {
    const data = {
      did: sessionState.user.did,
      host: window.location.host,
      appPid: window.blocklet.appPid,
      visitorId: getVisitorId(),
      sourceAppPid: sessionState.user.sourceAppPid,
      fullName: sessionState.user.fullName,
    };
    debug('bridge callArc: onLogin', data);
    bridge.callArc('onLogin', data);
  };

  const onLogin = async (result, decryptDidConnect) => {
    const decodeCsrfToken = decryptDidConnect(result.csrfToken);
    const decodeSessionToken = decryptDidConnect(result.sessionToken);
    const decodeRefreshToken = decryptDidConnect(result.refreshToken);
    const decodeVisitorId = decryptDidConnect(result.visitorId);
    debug('login page onLogin', { result, decodeSessionToken, decodeRefreshToken, decodeVisitorId });
    setSessionToken(decodeSessionToken);
    setCsrfToken(decodeCsrfToken);
    setRefreshToken(decodeRefreshToken);

    if (result.visitorId) setVisitorId(decodeVisitorId);
    await session.refresh();

    // HACK: 由于数据闭包的问题，必须增加 sleep 及 latestSession 的包装
    await sleep(100);
    notifyBridge(latestSession.current);

    const connectedInfo = {};
    if (searchParams.get('saveConnect')) {
      connectedInfo.connected_did = latestSession.current.user.did;
      connectedInfo.connected_pk = latestSession.current.user.pk;
      connectedInfo.connected_wallet_os = latestSession.current.walletOS;
      connectedInfo.connected_app = getAppId();
    } else {
      connectedInfo.connected_did = searchParams.get('connected_did');
      connectedInfo.connected_pk = searchParams.get('connected_pk');
      connectedInfo.connected_app = searchParams.get('connected_app');
      connectedInfo.connected_wallet_os = searchParams.get('connected_wallet_os');
    }

    updateConnectedInfo(connectedInfo, true);

    redirectAfterLogin({
      sessionToken: decodeSessionToken,
      refreshToken: decodeRefreshToken,
      visitorId: decodeVisitorId,
    });
  };

  const messages = useCreation(() => {
    if (origin === 'switch-did') {
      if (forceConnected && typeof forceConnected === 'string') {
        return {
          title: t('login.switchSpecifiedDid.title'),
          scan: t('login.switchSpecifiedDid.scan', { did: forceConnected }),
          confirm: t('login.switchSpecifiedDid.confirm'),
          success: t('login.switchSpecifiedDid.success'),
        };
      }
      return {
        title: t('login.switchDid.title'),
        scan: t('login.switchDid.scan'),
        confirm: t('login.switchDid.confirm'),
        success: t('login.switchDid.success'),
      };
    }
    return {
      title: t('login.connect.title'),
      scan: t('login.connect.scan'),
      confirm: t('login.connect.confirm'),
      success: t('login.connect.success'),
    };
  }, [forceConnected, origin, t]);

  const gotoLogin = useMemoizedFn(() => {
    const blocklet = window?.blocklet;

    const params = {
      className: 'connect',
      popup: false,
      action: 'login',
      passkeyBehavior: 'both', // TODO: this should be decided by the blocklet settings
      onSuccess: onLogin,
      // eslint-disable-next-line no-use-before-define
      onError,
      locale,
      messages,
      extraParams,
      // HACK: 让 master 的登录页面向 member url 发起请求
      baseUrl: window.location.origin,
      prefix: joinURL(window.location.origin, WELLKNOWN_SERVICE_PATH_PREFIX, API_DID_PREFIX),
    };

    if (forceConnected) {
      params.forceConnected = forceConnected;
      params.extraParams.enableSwitchApp = false;
      params.extraParams.forceConnected = forceConnected;
    }
    if (!params.options) {
      params.options = {};
    }
    if (origin === 'switch-did') {
      params.options.showQuickConnect = true;
    } else if (!isNil(showQuickConnect)) {
      if ([false, 'false'].includes(showQuickConnect)) {
        params.options.showQuickConnect = false;
      } else {
        params.options.showQuickConnect = true;
      }
    }
    const masterSite = getMaster();
    const federatedEnabled = getFederatedEnabled();
    if (federatedEnabled) {
      params.extraParams.sourceAppPid = masterSite.appPid;
    }

    // member 登录不再跳转到 master，而使用 sourceAppPid 来决定默认登录的站点
    const connectURL = joinURL(window.location.origin, WELLKNOWN_SERVICE_PATH_PREFIX, 'connect');
    const queryParams = {
      params: encodeConnectUrl(encodeURIComponent(JSON.stringify(params))),
      appPid: blocklet?.appPid,
      appName: blocklet?.appName,
      locale,
      redirect: window.location.href,
      _ek_: encryptKey,
    };

    if (!isNil(autoConnectWebview)) {
      queryParams.autoConnectWebview = autoConnectWebview;
    }
    if (!isNil(popup)) {
      queryParams.popup = popup;
    }
    queryParams.disableClose = true;

    // url 可能是 master-url 或本地，可以信任
    const targetUrl = getSafeUrlWithToast(withQuery(connectURL, queryParams), { allowDomains: null });
    window.location.href = targetUrl;
  });

  const startDebosGoogleLogin = useMemoizedFn(() => {
    const appDid = window?.env?.appId || window?.blocklet?.appPid;
    if (!appDid) {
      Toast.error('Unable to determine this DeBOS instance DID');
      return;
    }

    const targetUrl = withQuery(joinURL(debosGoogleBrokerUrl, '/oauth/debos-login/google'), {
      appDid,
      redirect: getRelativeRedirect(redirect),
      locale,
    });
    window.location.href = getSafeUrlWithToast(targetUrl, { allowDomains: null });
  });

  const exchangeDebosGoogleGrant = useMemoizedFn(async () => {
    const response = await fetch(
      joinURL(window?.env?.apiPrefix || WELLKNOWN_SERVICE_PATH_PREFIX, '/api/debos-google-login/exchange'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          grant: debosGoogleGrant,
          visitorId,
          locale,
        }),
      }
    );

    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.error || result?.message || 'Google login failed');
    }

    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete('debosGoogleGrant');
    window.history.replaceState(null, '', currentUrl.toString());

    await onLogin(result, (v) => v);
  });

  useMount(() => {
    if (debosGoogleGrant) {
      exchangeDebosGoogleGrant().catch((err) => {
        Toast.error(err.message || 'Google login failed');
      });
    } else if (searchParams.get('sessionToken')) {
      const vid = searchParams.get('visitorId');
      if (!vid) {
        Toast.error('Unexpected login response from server: visitorId is required');
        return;
      }

      onLogin(
        {
          sessionToken: decrypt(sessionToken),
          csrfToken: decrypt(csrfToken),
          refreshToken: decrypt(refreshToken),
          visitorId: decrypt(vid),
        },
        (v) => v
      );
    } else if (!session.user || (forceConnected && session.user.did !== forceConnected)) {
      if (!canUseDebosGoogleLogin) {
        gotoLogin();
      }
    } else if (!authenticated && !searchParams.get('sessionToken')) {
      redirectAfterLogin();
    }
  });

  const onError = (err) => {
    Toast.error(err.message);
  };

  const seamless = searchParams.has('popup');

  if (session.loading || session.user) {
    if (!authenticated || searchParams.get('sessionToken')) {
      return (
        <>
          <Helmet>
            <title>{t('pageTitle.login')}</title>
          </Helmet>
          <Center>{seamless ? null : <CircularProgress />}</Center>
        </>
      );
    }
    const redirectUrl = redirect ? new URL(redirect, window.location.origin).href : window.location.href;
    return <PassportPaywall onConnect={gotoLogin} passports={parsedRequiredRoles} redirect={redirectUrl} />;
  }

  return (
    <>
      <Helmet>
        <title>{t('pageTitle.login')}</title>
      </Helmet>
      <Box
        sx={{
          'box-sizing': 'border-box',
          width: '100%',
          height: '100vh',
          position: 'relative',
          display: 'flex',
          'align-items': canUseDebosGoogleLogin ? 'center' : 'stretch',
          'justify-content': canUseDebosGoogleLogin ? 'center' : 'flex-start',
          'flex-direction': 'column',
          p: canUseDebosGoogleLogin ? 2 : 0,
          bgcolor: canUseDebosGoogleLogin ? '#f7faf9' : 'transparent',
          '.connect': {
            background: '#fafafa',
          },
        }}
        ref={containerRef}>
        {canUseDebosGoogleLogin && (
          <Paper elevation={0} sx={{ width: '100%', maxWidth: 420, p: 4, border: '1px solid', borderColor: 'divider' }}>
            <Stack spacing={3}>
              <Box>
                <Typography variant="h5" fontWeight={700}>
                  Sign in to {window?.env?.appName || 'DeBOS'}
                </Typography>
                <Typography color="text.secondary" sx={{ mt: 1 }}>
                  Continue with the Google account that owns this DeBOS instance.
                </Typography>
              </Box>

              <Stack spacing={1.5}>
                <Button size="large" variant="contained" onClick={startDebosGoogleLogin}>
                  Continue with Google
                </Button>
                <Button size="large" variant="outlined" onClick={gotoLogin}>
                  Use DID Wallet or Passkey
                </Button>
              </Stack>
            </Stack>
          </Paper>
        )}
      </Box>
    </>
  );
}
