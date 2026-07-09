import { getServerAuthMethod } from '@abtnode/auth/lib/util/get-auth-method';
import { getServerUrl, getWalletType } from '@abtnode/ux/lib/blocklet/util';
import WithoutWallet from '@abtnode/ux/lib/blocklet/without-wallet';
import DidAddress from '@abtnode/ux/lib/did-address';
import ContentLayout from '@abtnode/ux/lib/launch-blocklet/content-layout';
import { getDidConnectParam, getLauncherUrl } from '@abtnode/ux/lib/launch-blocklet/use-extra-nav';
import { getBlockletUrls, getLauncherBaseURL } from '@abtnode/ux/lib/util';
import { api as $api, axios } from '@abtnode/ux/lib/util/api';
import getSafeUrlWithToast from '@abtnode/ux/lib/util/get-safe-url';
import Connect, { useSecurity } from '@arcblock/did-connect-react/lib/Connect';
import AnimationWaiter from '@arcblock/ux/lib/AnimationWaiter';
import Center from '@arcblock/ux/lib/Center';
import ProviderIcon from '@arcblock/ux/lib/DIDConnect/provider-icon';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import Toast from '@arcblock/ux/lib/Toast';
import { BlockletEvents } from '@blocklet/constant';
import { LOGIN_PROVIDER, LOGIN_PROVIDER_NAME } from '@arcblock/ux/lib/Util/constant';
import LauncherResultMessage from '@blocklet/launcher-layout/lib/launch-result-message';
import PageHeader from '@blocklet/launcher-layout/lib/page-header';
import ProgressMessage from '@blocklet/launcher-ux/lib/progress-message';
import { titleSchema } from '@blocklet/meta/lib/schema';
import { getDisplayName, hasStartEngine } from '@blocklet/meta/lib/util';
import styled from '@emotion/styled';
import ArrowForward from '@mui/icons-material/ArrowForward';
import {
  useTheme,
  CircularProgress as Spinner,
  Link as ExternalLink,
  Box,
  Alert,
  Typography,
  Button as MuiButton,
} from '@mui/material';
import { useCreation, useMemoizedFn } from 'ahooks';
import Debug from 'debug';
import isEmpty from 'lodash/isEmpty';
import isEqual from 'lodash/isEqual';
import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useLocalStorage from 'react-use/lib/useLocalStorage';
import useSetState from 'react-use/lib/useSetState';
import { joinURL, withQuery } from 'ufo';

// eslint-disable-next-line import/no-unresolved
import { BLOCKLET_INSTALL_TYPE, DEBOS_BLOCKLET_DID, WELLKNOWN_SERVICE_PATH_PREFIX } from '@abtnode/constant';
import serverLogo from '../../assets/logo.svg';
import { useLaunchBlockletContext } from '../../contexts/launch-blocklet';
import { useNodeContext } from '../../contexts/node';
import useRuntimeBlockletState from '../../contexts/runtime-blocklet-state';
import { useSessionContext } from '../../contexts/session';
import useQuery from '../../hooks/query';
import {
  formatError,
  getAccessibleUrl,
  getWebWalletUrl,
  isNewStoreUrl,
  setRefreshToken,
  setSessionToken,
} from '../../libs/util';
import AppLogo from './app-logo';
import Button from './button';
import DownloadBundleProgress from './download-progress';
import { authorize, isServerlessBlockletInstalled } from './util';
import WaiterContainer from './wait-container';

const debug = Debug('@abtnode/webapp:launch-blocklet:step-install');

const isAlreadyInstalled = (status, state) =>
  !state.statusChanged && (status === 'installed' || status === 'running') && !state.launching;

const getAuthDialogDescription = (isFree, authMethod, t) => {
  if (authMethod === 'nft') {
    return isFree ? t('launchBlocklet.dialog.nftFreeDescription') : t('launchBlocklet.dialog.nftPaidDescription');
  }

  return isFree ? t('launchBlocklet.dialog.freeDescription') : t('launchBlocklet.dialog.paidDescription');
};

const SETUP_TOKEN_KEY = '__temp_setup_token';
const VISITOR_ID_KEY = '__temp_visitor_id';
const CONNECT_DATA_TYPE_DEBOS_LAUNCH_LOGIN = 'debos-launch-login';

function DebosGoogleLogin({ extraParams, onSuccess }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    const configUrl = joinURL(window?.env?.apiPrefix ?? '/', '/api/oauth/debos-launch/config');

    axios
      .get(configUrl)
      .then(({ data }) => {
        if (mounted) {
          setEnabled(data?.google?.enabled === true);
        }
      })
      .catch(error => {
        debug('Failed to load Google OAuth config for DeBOS launch', error);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      const startUrl = joinURL(window.location.origin, window?.env?.apiPrefix ?? '/', '/oauth/debos-launch/google');
      const oauthResult = await new Promise((resolve, reject) => {
        let closeTimer;
        let timeout;

        const cleanup = handleMessage => {
          window.removeEventListener('message', handleMessage);
          clearInterval(closeTimer);
          clearTimeout(timeout);
        };
        const handleMessage = event => {
          if (event.origin !== window.location.origin || event.data?.type !== 'debos-google-oauth') {
            return;
          }
          cleanup(handleMessage);
          if (event.data.error || !event.data.code || !event.data.state) {
            reject(new Error(event.data.error || 'Google sign-in did not complete'));
            return;
          }
          resolve(event.data);
        };

        window.addEventListener('message', handleMessage);
        const popup = window.open(startUrl, 'debos-google-oauth', 'popup,width=500,height=700');
        if (!popup) {
          cleanup(handleMessage);
          reject(new Error('Please allow the Google sign-in popup'));
          return;
        }

        closeTimer = setInterval(() => {
          if (popup.closed) {
            cleanup(handleMessage);
            reject(new Error('Google sign-in was cancelled'));
          }
        }, 500);
        timeout = setTimeout(
          () => {
            popup.close();
            cleanup(handleMessage);
            reject(new Error('Google sign-in timed out'));
          },
          5 * 60 * 1000
        );
      });

      const loginUrl = joinURL(window?.env?.apiPrefix ?? '/', '/api/oauth/debos-launch/login');
      const { data } = await axios.post(loginUrl, {
        ...extraParams,
        code: oauthResult.code,
        state: oauthResult.state,
      });
      if (data?.sessionToken) {
        await onSuccess({ ...data, encrypted: false });
      }
    } catch (error) {
      Toast.error(formatError(error), { autoHideDuration: 5000 });
    } finally {
      setLoading(false);
    }
  };

  if (!enabled) {
    return null;
  }

  return (
    <MuiButton
      fullWidth
      variant="outlined"
      disabled={loading}
      onClick={handleGoogleLogin}
      startIcon={
        loading ? (
          <Spinner size={18} />
        ) : (
          <ProviderIcon provider={LOGIN_PROVIDER.GOOGLE} sx={{ width: 22, height: 22 }} />
        )
      }
      sx={{ justifyContent: 'flex-start', px: 2, py: 1.25, textTransform: 'none' }}>
      {`Continue with ${LOGIN_PROVIDER_NAME[LOGIN_PROVIDER.GOOGLE] || 'Google'}`}
    </MuiButton>
  );
}

DebosGoogleLogin.propTypes = {
  extraParams: PropTypes.object.isRequired,
  onSuccess: PropTypes.func.isRequired,
};

// FIXME: @zhenqiang 这个文件里面的 url 拼接感觉比较乱，后续不好维护，我们需要梳理下

export default function Install() {
  const query = useQuery();
  const { t, locale } = useLocaleContext();
  const { api, info } = useNodeContext();
  const { session, api: rest } = useSessionContext();
  const navigate = useNavigate();
  const {
    loading,
    meta,
    isFree,
    appDid,
    sessionId,
    storeUrl,
    blockletMetaUrl,
    isExternal,
    setAppDid,
    launcherUrl,
    launcherSessionId,
    launcherSession,
    isInstalling,
    isInstalled: isBlockletInstalled,
  } = useLaunchBlockletContext();
  const blockletName = meta ? getDisplayName({ meta }, true) : null;
  const launchType = query.get('launchType');
  const chainHost = query.get('chainHost');
  const onlyRequired = !!query.get('onlyRequired');
  const nftId = query.get('nftId');
  // 当前安装过程中的状态
  const from = query.get('from');
  // 通过 URL 安装
  const installFromUrl = from === 'url';
  // 创建 empty blocklet
  const isEmptyBlocklet = from === 'empty';

  const timer = useRef(null);
  const { decrypt, encryptKey } = useSecurity();
  const theme = useTheme();
  const [nw, setNw] = useState('');

  const [skipSetup] = useLocalStorage('skip-blocklet-setup', false);

  const [state, setState] = useSetState({
    launching: false, // 是否正在安装
    visiting: false, // 是否正在跳转到 blocklet
    statusChanged: false,
    isConnectOpen: false,
    nextAccessUrl: '',
    loaded: false,
    installError: null,
    progressIndex: 0,
    connectData: {
      action: '',
      baseUrl: '',
      checkFn: () => {},
      extraParams: {},
    },
  });

  const isAuthorized = authorize({ user: session.user, launchType, nftId, blockletDid: meta?.did });

  const authMethod = getServerAuthMethod(info, launchType, launcherSessionId, isAuthorized);
  const launchWithoutWallet = launcherSessionId && launcherSession && !launcherSession.walletDid;

  const isFromLauncher = useCreation(() => from === 'launcher', [from]);
  const isDebosBlocklet = meta?.did === DEBOS_BLOCKLET_DID;
  const needsDebosLaunchLogin = isDebosBlocklet && !session.user && !isFromLauncher;

  const installType = useMemo(() => {
    if (isEmptyBlocklet) {
      return BLOCKLET_INSTALL_TYPE.CREATE;
    }
    if (installFromUrl) {
      return BLOCKLET_INSTALL_TYPE.URL;
    }
    return BLOCKLET_INSTALL_TYPE.STORE;
  }, [isEmptyBlocklet, installFromUrl]);

  /**
   * 如果存在 wallet 账户，并且不是通过 launchWithoutWallet 启动的，无需在绑定 wallet 账户
   */
  const existWalletAccount = useMemo(() => {
    if (!session.user) {
      return false;
    }
    const connectedAccounts = session.user?.connectedAccounts || [];
    const hasWallet = connectedAccounts.some(x => x.provider === LOGIN_PROVIDER.WALLET);
    return hasWallet;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user]);
  const shouldLaunchDebosWithoutWallet = isDebosBlocklet && session.user && !existWalletAccount && !isFromLauncher;

  const runtimeBlockletState = useRuntimeBlockletState(isAuthorized ? appDid : '');
  const { status, eventName } = runtimeBlockletState;

  useEffect(() => {
    if (loading) {
      return;
    }

    if (!isBlockletInstalled && !isInstalling) {
      // eslint-disable-next-line no-use-before-define
      handleLaunchStart();
    }

    setState({ loaded: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const addNewRegistryToRegistryList = async () => {
    const { isNew: isNewStoreRegistry, decoded } = isNewStoreUrl(storeUrl, info.blockletRegistryList);

    // 未添加到 store registryList，进行添加
    if (isNewStoreRegistry) {
      await api.addBlockletStore({ input: { teamDid: info.did, url: decoded } });
    }
  };

  const getLaunchAppName = (user = session.user) => {
    let appName = blockletName;
    if (user && !isEmptyBlocklet) {
      // Just in case the name is too long
      const betterName = `${user.fullName}'s ${blockletName}`;
      const { error } = titleSchema.validate(betterName);
      if (!error) {
        appName = betterName;
      } else {
        console.warn({ appName, betterName, error });
      }
    }
    return appName;
  };

  const launchBlockletWithoutWallet = async (user = session.user) => {
    const appName = getLaunchAppName(user);
    const description = meta?.description;
    debug('launchBlockletWithoutWallet', {
      title: appName,
      blockletMetaUrl,
    });
    const { data } = await api.launchBlockletWithoutWallet({
      input: {
        title: appName,
        blockletMetaUrl: blockletMetaUrl || '',
        type: installType,
        description,
        storeUrl: storeUrl || '',
        onlyRequired,
      },
    });
    return data;
  };

  const handleConnectSuccess = async results => {
    debug('handleConnectSuccess', results);
    Toast.success(t('launchBlocklet.dialog.success'));

    const result = Array.isArray(results) ? results[results.length - 1] : results;

    if (state.connectData.type === CONNECT_DATA_TYPE_DEBOS_LAUNCH_LOGIN && result.sessionToken) {
      if (result.sessionToken) {
        setSessionToken(
          result.sessionToken.split('.').length === 3 ? result.sessionToken : decrypt(result.sessionToken)
        );
      }
      if (result.refreshToken) {
        setRefreshToken(
          result.refreshToken.split('.').length === 3 ? result.refreshToken : decrypt(result.refreshToken)
        );
      }
      if (result.visitorId) {
        sessionStorage.setItem(VISITOR_ID_KEY, result.visitorId);
      }

      await session.refresh();
      setState({ isConnectOpen: false, launching: true });
      try {
        const data = await launchBlockletWithoutWallet();
        handleConnectSuccess(data);
      } catch (error) {
        console.error('launchBlockletWithoutWalletAfterLogin error:', error);
        setState({ launching: false });
        Toast.error(formatError(error), { autoHideDuration: 3000 });
      }
      return;
    }

    if (result.sessionToken) {
      // 如果 sessionToken 是三段式 JWT Token，则直接使用，否则使用 decrypt 解密
      setSessionToken(result.sessionToken.split('.').length === 3 ? result.sessionToken : decrypt(result.sessionToken));
      await session.refresh();
    }

    if (result.setupToken) {
      // 防止刷新页面丢失 setupToken, 所以存在 Session Storage
      sessionStorage.setItem(SETUP_TOKEN_KEY, result.setupToken);
    }

    // 安装应用的时候服务端可能会生成新的 visitorId
    // 如果有 visitorId, 先保存到 sessionStorage, 为后续跳转到 Blocklet Setup 页面做准备
    if (result.visitorId) {
      sessionStorage.setItem(VISITOR_ID_KEY, result.visitorId);
    }

    setState({ launching: !result.isInstalled, isConnectOpen: false });
    if (result.appDid) {
      setAppDid(result.appDid, result.sessionId);
      const url = new URL(window.location.href);
      url.searchParams.set('appDid', result.appDid);
      url.searchParams.set('sessionId', result.sessionId);
      window.history.replaceState(null, '', url.toString());
    }
  };

  const handleLaunchBlockletByLauncher = async () => {
    setState({ isConnectOpen: false, launching: true });
    let appName = blockletName;
    const description = meta?.description;
    if (session.user && !isEmptyBlocklet) {
      // Just in case the name is too long
      const betterName = `${session.user.fullName}'s ${blockletName}`;
      const { error } = titleSchema.validate(betterName);
      if (!error) {
        appName = betterName;
      } else {
        console.warn({ appName, betterName, error });
      }
    }
    try {
      const { data } = await api.launchBlockletByLauncher({
        input: {
          title: appName,
          description,
          blockletMetaUrl,
          launcherSessionId,
          launcherUrl,
          chainHost: decodeURIComponent(chainHost),
          onlyRequired,
          type: installType,
          storeUrl,
        },
      });

      // eslint-disable-next-line no-use-before-define
      handleConnectSuccess(data);
    } catch (error) {
      console.error('launchBlockletByLauncher error:', error);
      Toast.error(formatError(error), { autoHideDuration: 3000 });
    }
  };

  const openDebosLaunchLogin = useMemoizedFn(() => {
    setState({
      isConnectOpen: true,
      launching: false,
      connectData: {
        type: CONNECT_DATA_TYPE_DEBOS_LAUNCH_LOGIN,
        action: 'login-debos-launch',
        baseUrl: '',
        checkFn: axios.create({ baseURL: window?.env?.apiPrefix ?? '/' }).get,
        extraParams: {
          blockletMetaUrl,
          locale,
        },
      },
    });
  });

  const handleLaunchStart = async () => {
    debug('handleLaunchStart', { launcherSessionId, launcherSession });
    let appName = blockletName;
    const description = meta?.description;
    if (session.user && !isEmptyBlocklet) {
      // Just in case the name is too long
      const betterName = `${session.user.fullName}'s ${blockletName}`;
      const { error } = titleSchema.validate(betterName);
      if (!error) {
        appName = betterName;
      } else {
        console.warn({ appName, betterName, error });
      }
    }

    setState({ installError: null });

    if (needsDebosLaunchLogin) {
      openDebosLaunchLogin();
      return;
    }

    if (shouldLaunchDebosWithoutWallet) {
      await handleLaunchBlockletWithoutWallet();
      return;
    }

    if (session?.user && !isExternal && launchType !== 'serverless') {
      try {
        await addNewRegistryToRegistryList();
      } catch (error) {
        console.error('addNewRegistryToRegistryList error:', error);
      }
    }

    if (isFree) {
      const nextAction = `launch-free-blocklet-by-${authMethod}`;
      setState({
        isConnectOpen: true,
        connectData: {
          action: nextAction,
          baseUrl: '',
          checkFn: axios.create({ baseURL: window?.env?.apiPrefix ?? '/' }).get,
          extraParams: {
            wt: getWalletType(meta),
            title: appName,
            blockletMetaUrl,
            description,
            launchType,
            nftId,
            chainHost: decodeURIComponent(chainHost),
            launcherUrl,
            launcherSessionId,
            onlyRequired,
            type: installType,
            storeUrl,
          },
        },
      });
    } else {
      // For paid blocklet, we need always check the purchase first
      // After that we can launch with nft/vc/session
      const nextAction = `launch-paid-blocklet-by-${authMethod}`;
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = joinURL(window?.env?.apiPrefix ?? '/', `/api/did/${nextAction}/token`);
      nextUrl.searchParams.set('wt', getWalletType(meta));
      nextUrl.searchParams.set('_ek_', encryptKey);
      nextUrl.searchParams.set('title', appName);
      nextUrl.searchParams.set('autoConnect', false);
      nextUrl.searchParams.set('blockletMetaUrl', blockletMetaUrl);
      if (launchType) {
        nextUrl.searchParams.set('launchType', launchType);
      }
      if (nftId) {
        nextUrl.searchParams.set('nftId', nftId);
      }
      if (launcherUrl) {
        nextUrl.searchParams.set('launcherUrl', launcherUrl);
      }
      if (launcherSessionId) {
        nextUrl.searchParams.set('launcherSessionId', launcherSessionId);
      }

      const { data } = await $api.get(nextUrl.href);
      const baseUrl = storeUrl || new URL(blockletMetaUrl).origin;

      setState({
        isConnectOpen: true,
        connectData: {
          action: 'verify-purchase-blocklet',
          baseUrl,
          checkFn: axios.create({ baseURL: baseUrl }).get,
          extraParams: {
            serverDid: info.did,
            blockletDid: meta?.did,
            nw: data.url,
            type: installType,
            storeUrl,
          },
        },
      });
    }
  };

  const getNextWorkFlow = useCallback(async () => {
    if (
      state.connectData.type === CONNECT_DATA_TYPE_DEBOS_LAUNCH_LOGIN ||
      shouldLaunchDebosWithoutWallet ||
      isFromLauncher ||
      existWalletAccount ||
      !state.connectData.action
    ) {
      return '';
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.pathname = joinURL(window?.env?.apiPrefix ?? '/', `/api/did/${state.connectData.action}/token`);
    nextUrl.searchParams.set('_ek_', encryptKey);
    Object.keys(state.connectData.extraParams).forEach(key => {
      nextUrl.searchParams.set(key, state.connectData.extraParams[key]);
    });
    const { data } = await $api.get(nextUrl.href);
    if (data.url) {
      setNw(data.url);
    } else {
      setNw('');
    }
    return undefined;
  }, [
    shouldLaunchDebosWithoutWallet,
    existWalletAccount,
    isFromLauncher,
    state.connectData.type,
    state.connectData.action,
    state.connectData.extraParams,
    encryptKey,
  ]);

  async function handleLaunchBlockletWithoutWallet() {
    setState({ isConnectOpen: false, launching: true });
    try {
      const data = await launchBlockletWithoutWallet();
      handleConnectSuccess(data);
    } catch (error) {
      console.error('launchBlockletWithoutWallet error:', error);
      Toast.error(formatError(error), { autoHideDuration: 3000 });
    }
  }

  const redirectToBlockletOverview = b => {
    const accessUrl = `/${info.routing.adminPath}/blocklets/${b.meta.did}/configuration`.replace(/\/+/g, '/');
    let nextUrl = `/launch-blocklet/complete?status=installed&name=${encodeURIComponent(
      blockletName
    )}&accessUrl=${encodeURIComponent(accessUrl)}&blocklet_meta_url=${blockletMetaUrl}&theme=${theme.palette.mode}`;

    const fromLauncher = query.get('fromLauncher');

    if (fromLauncher) {
      nextUrl += `&fromLauncher=${fromLauncher}`;
    }

    if (launchType) {
      nextUrl += `&launchType=${launchType}`;
    }
    if (launcherUrl) {
      nextUrl += `&launcherUrl=${launcherUrl}`;
    }

    if (chainHost) {
      nextUrl += `&chainHost=${chainHost}`;
    }

    navigate(nextUrl);
  };

  useEffect(() => {
    getNextWorkFlow();
  }, [getNextWorkFlow]);

  const extraParams = useMemo(() => {
    // 不存在 wallet 账户需要绑定 wallet 账户
    if (!isFromLauncher && !existWalletAccount && nw && session.user) {
      return {
        nw,
        previousUserDid: session.user?.did,
        skipMigrateAccount: true,
      };
    }
    return state.connectData.extraParams;
  }, [state.connectData.extraParams, existWalletAccount, isFromLauncher, nw, session.user]);

  // 跳转到下一步
  const visitBlocklet = async b => {
    debug('visitBlocklet', { status, state, appDid });
    if (state.visiting) {
      return;
    }
    setState({ visiting: true });

    const urls = getBlockletUrls({ blocklet: b });
    const accessUrl = await getAccessibleUrl(urls);

    // serverless 应用不要跳转到 overview 页面
    if ((isEmpty(accessUrl) && launchType !== 'serverless') || skipSetup) {
      setState({ visiting: false });
      setTimeout(() => {
        redirectToBlockletOverview(b);
      }, 1000);
      return;
    }

    if (isEmpty(accessUrl)) {
      setState({ visiting: false });
      return;
    }

    if (isAlreadyInstalled(status, state) === false) {
      try {
        // end session
        await rest.post(`/api/launch/${sessionId}`);
      } catch (err) {
        debug('end launch failed', { error: formatError(err) });
      }
    }

    let targetUrl = accessUrl;
    // 如果是创建的 empty blocklet 或者可能直接走 nginx 的，则需要跳转到 blocklet setup 页面
    if ((isEmptyBlocklet || !hasStartEngine(b.meta)) && appDid) {
      targetUrl = joinURL(accessUrl || '', WELLKNOWN_SERVICE_PATH_PREFIX, '/setup');
    }

    const url = new URL(targetUrl);
    // 统一主题
    url.searchParams.set('theme', theme.palette.mode);
    // install blocklet 并跳转到 blocklet setup 界面时携带 serverUrl 查询参数
    url.searchParams.set('serverUrl', getServerUrl(info));

    if (b.status !== 'running') {
      url.searchParams.set('__start__', '1');
    }

    const fromLauncher = query.get('fromLauncher');
    if (fromLauncher) {
      url.searchParams.set('fromLauncher', fromLauncher);
    }

    if (launchType) {
      url.searchParams.set('launchType', launchType);
    }

    if (launcherUrl) {
      url.searchParams.set('launcherUrl', launcherUrl);
    }

    if (nftId) {
      url.searchParams.set('nftId', nftId);
    }

    if (chainHost) {
      url.searchParams.set('chainHost', chainHost);
    }

    const setupToken = sessionStorage.getItem(SETUP_TOKEN_KEY);
    if (setupToken) {
      url.searchParams.set('setupToken', setupToken);
    }

    const visitorId = sessionStorage.getItem(VISITOR_ID_KEY);
    if (visitorId) {
      url.searchParams.set('visitorId', visitorId);
    }

    if (isEmptyBlocklet) {
      url.searchParams.set('from', 'empty');
    }

    setState({ nextAccessUrl: url.href, visiting: false });

    setTimeout(() => {
      sessionStorage.removeItem(SETUP_TOKEN_KEY);
      sessionStorage.removeItem(VISITOR_ID_KEY);

      // 从 blocklet.site.domainAliases 中获得，可以信任
      window.location.href = getSafeUrlWithToast(url.href, { allowDomains: null });
    }, 1000);
  };

  const progressSteps = [
    t('launchBlocklet.waiting.verifying'),
    t('launchBlocklet.waiting.downloading'),
    t('launchBlocklet.waiting.extracting'),
    status === 'upgrading' ? t('common.upgrading') : t('launchBlocklet.waiting.installing'),
    t('launchBlocklet.waiting.done'),
  ];

  const installedMessages = useCreation(() => {
    return [
      t('launchBlocklet.waiting.initializing'),
      t('launchBlocklet.waiting.initializingOwner'),
      t('launchBlocklet.waiting.creatingSecurityRules'),
      t('launchBlocklet.waiting.assigningDomain'),
      t('launchBlocklet.waiting.waitingForDomain'),
    ];
  }, [t]);

  const handleInstalledProgress = () => {
    debug('handleInstalledProgress', { status, state });
    if (status) {
      setState({ progressIndex: 4 });

      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      timer.current = setTimeout(() => {
        api.getBlocklet({ input: { did: appDid, attachRuntimeInfo: true } }).then(res => {
          if (res.blocklet && res.blocklet.site) {
            visitBlocklet(res.blocklet);
          }
        });
      }, 500);
    }
  };

  useEffect(() => {
    if (isInstalling) {
      setState({ launching: true });
    }

    if (isBlockletInstalled) {
      handleInstalledProgress();
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBlockletInstalled, isInstalling]);

  useEffect(() => {
    if (launchType === 'serverless' && eventName === BlockletEvents.nftConsumed) {
      handleInstalledProgress();
      return;
    }

    switch (status) {
      case 'waiting':
        setState({ progressIndex: 1, statusChanged: true });
        break;
      case 'downloading':
        setState({ progressIndex: 2, statusChanged: true });
        break;
      case 'installing':
      case 'upgrading':
        setState({ progressIndex: 3, statusChanged: true });
        break;
      case 'installed':
        if (launchType === 'serverless' && !isServerlessBlockletInstalled(runtimeBlockletState)) {
          break;
        }

        handleInstalledProgress();
        break;
      case 'starting':
        handleInstalledProgress();
        break;
      case 'running':
        handleInstalledProgress();
        break;
      case 'stopped':
        handleInstalledProgress();
        break;
      case 'corrupted':
      case 'error':
        // WARN: 暂时不要直接使用 runtimeBlockletState 的 error 数据；
        // 当下载中失败时，core/webapp/src/libs/ws.js 触发downloadFailed后，会更新一次 downloading，会让 error 被清理；所以error后，要通过 setState(setInstallError) 保存后使用；
        {
          const errorData = {
            message: runtimeBlockletState.error.message,
            name: runtimeBlockletState.eventName,
          };

          if ([BlockletEvents.downloadFailed, BlockletEvents.installFailed].includes(runtimeBlockletState.eventName)) {
            errorData.action = 'retry';
          } else if (status === 'error' || status === 'corrupted') {
            errorData.action = 'view';
          }
          if (!isEqual(errorData, state.installError)) {
            if (runtimeBlockletState?.error?.message) {
              Toast.error(formatError(runtimeBlockletState.error));
            }
          }
        }

        break;
      default:
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, eventName, runtimeBlockletState]);

  debug('render', {
    status,
    isInstalling,
    isBlockletInstalled,
    eventName,
    launchType,
    launcherSessionId,
    runtimeBlockletState,
    state,
  });

  const getLauncherBlockletUrl = useMemoizedFn(async () => {
    if (!launcherSession) {
      return '';
    }

    const didConnectParam = getDidConnectParam(launcherSession?.userDid);
    const baseUrl = getLauncherUrl(launcherUrl);
    const launchPath = launcherSessionId ? `/apps/${launcherSessionId}/overview` : 'apps';
    const baseLauncherUrl = await getLauncherBaseURL(baseUrl);
    const redirectUrl = withQuery(joinURL(baseLauncherUrl, '/u/', launchPath), didConnectParam);

    return redirectUrl;
  }, [launcherSessionId, launcherUrl]);

  useEffect(() => {
    if (launcherSession?.status >= 50) {
      getLauncherBlockletUrl().then(url => {
        setState({ nextAccessUrl: url });
        setTimeout(() => {
          window.location.href = url;
        }, 2000);
      });
    }
  }, [launcherSession, getLauncherBlockletUrl, setState]);

  // View: Loading
  if (loading || (session.user && status === null) || isEmpty(meta)) {
    return (
      <Center relative="parent">
        <Spinner />
      </Center>
    );
  }

  // View: Error
  if (state.installError) {
    const errorActions = {
      view: !isExternal && (
        <Button
          className="bottom-button"
          component={Link}
          to={`/blocklets/${appDid}/overview`}
          data-cy="view-blocklet"
          color="primary"
          variant="contained">
          {t('launchBlocklet.viewApplication')}
        </Button>
      ),
      retry: (
        <ButtonContainer>
          {from && (
            <Button
              variant="text"
              className="bottom-button"
              data-cy="go-back"
              disabled={state.isConnectOpen}
              onClick={() => {
                // 只找到此处一个来源 core/ux/src/blocklet/util.js:23 是本地 url，严格限制 allowDomains
                // 如果是通过 URL 安装或者创建了一个空的 blocklet，则需要跳转到 blocklet list 页面
                window.location.href = installFromUrl || isEmptyBlocklet ? '/blocklets' : getSafeUrlWithToast(from);
              }}>
              {t('common.back')}
            </Button>
          )}
          <Button
            className="bottom-button"
            data-cy="retry-install"
            disabled={state.isConnectOpen}
            onClick={handleLaunchStart}>
            {state.isConnectOpen && <Spinner size={16} />}
            {t('common.retry')}
          </Button>
        </ButtonContainer>
      ),
    };

    const errorEventName = state.installError.name ? state.installError.name.replace('blocklet.', '') : 'installFailed';

    return (
      <ResultMessage
        variant="error"
        title={blockletName}
        subTitle={
          <ErrorMessageSub>
            <div>{t(`launchBlocklet.error.${errorEventName}`)}</div>
            {state.installError.message && (
              <div className="error-desc">{t('common.errorMessage') + state.installError.message}</div>
            )}
          </ErrorMessageSub>
        }
        footer={errorActions[state.installError.action]}
      />
    );
  }

  // View: blocklet 初始状态为已安装
  if (isAlreadyInstalled(status, state)) {
    debug('alreadyExists', { status, state, runtimeBlockletState });
    return (
      <ResultMessage
        variant="info"
        title={t('common.reminder')}
        subTitle={t('launchBlocklet.alreadyExists', { name: getDisplayName({ meta }, true) })}
        footer={
          <div>
            {!state.nextAccessUrl && <Spinner size={16} />}
            {state.nextAccessUrl && (
              <ExternalLink href={state.nextAccessUrl} data-cy="open-blocklet">
                {t('launchBlocklet.redirect')}
              </ExternalLink>
            )}
          </div>
        }
      />
    );
  }

  if (launcherSession?.status >= 50) {
    return (
      <ResultMessage
        variant="info"
        title={t('common.reminder')}
        subTitle={t('launchBlocklet.alreadyConsumed')}
        footer={
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2 }}>
            <ExternalLink href={state.nextAccessUrl} data-cy="open-blocklet">
              {t('launchBlocklet.redirectToLauncherBlocklet')}
            </ExternalLink>
          </Box>
        }
      />
    );
  }

  const showInstall = !state.launching && !status;
  const isDebosLaunchLoginConnect = state.connectData.type === CONNECT_DATA_TYPE_DEBOS_LAUNCH_LOGIN;
  let didConnectAction = state.connectData.action;
  if (!isDebosLaunchLoginConnect && !shouldLaunchDebosWithoutWallet && !existWalletAccount && !isFromLauncher) {
    didConnectAction = 'bind-wallet';
  }

  if (!shouldLaunchDebosWithoutWallet && !isFromLauncher && !existWalletAccount && !nw && session.user) {
    return (
      <Center relative="parent">
        <Alert severity="error">
          {t('launchBlocklet.nwFailed')}
          <Typography
            component="span"
            onClick={() => {
              window.location.reload();
            }}
            sx={{
              fontSize: 14,
              cursor: 'pointer',
              color: 'primary.main',
            }}>
            {t('common.retry')}
          </Typography>
        </Alert>
      </Center>
    );
  }

  // View: 安装流程
  return (
    <Container>
      <div className="header">
        <PageHeader
          title={showInstall ? t('common.install') : t('common.installing')}
          subTitle={showInstall ? t('launchBlocklet.subTitle', { appName: blockletName, serverName: info.name }) : ''}
        />
      </div>
      <div className="body">
        {showInstall && (
          <>
            <div className="illustrations">
              <div className="ills-block ills-block-left">
                <div className="ills-block-inner">
                  <AppLogo
                    className="i-icon"
                    blocklet={{ meta }}
                    blockletMetaUrl={blockletMetaUrl}
                    storeUrl={storeUrl}
                  />
                  <div className="i-name">{blockletName}</div>
                </div>
              </div>
              <ArrowForward className="arrow-icon" />
              <div className="ills-block ills-block-right">
                <div className="ills-block-inner">
                  <img width="64" height="64" src={serverLogo} alt="" />
                  <div className="i-name">{info.name}</div>
                  <DidAddress size={12} responsive={false} compact did={info.did} />
                </div>
              </div>
            </div>
            {state.loaded && !isBlockletInstalled && !state.launching && (
              <Button
                className="bottom-button"
                data-cy="start-launch"
                disabled={state.isConnectOpen || launchWithoutWallet}
                onClick={handleLaunchStart}>
                {state.isConnectOpen || launchWithoutWallet ? <Spinner size={16} sx={{ mr: 1 }} /> : null}
                {t('launchBlocklet.confirmInstall')}
              </Button>
            )}
          </>
        )}
        {state.launching && (
          <WaiterContainer>
            {state.progressIndex !== 4 ? (
              <AnimationWaiter
                increaseSpeed={0.3}
                messageLoop={false}
                message={<ProgressMessage steps={progressSteps} stepIndex={state.progressIndex} autoGrowth={4000} />}
              />
            ) : null}

            {state.progressIndex === 4 ? (
              <AnimationWaiter
                messageDuration={1000}
                message={installedMessages.map(msg => (
                  <Box
                    key={msg}
                    sx={{
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      gap: 1,
                    }}>
                    <Spinner thickness={8} size={14} />
                    <span style={{ color: theme.palette.primary.main }}>{msg}</span>
                  </Box>
                ))}
              />
            ) : null}
            {/* downloading, extracting */}
            {[1, 2].includes(state.progressIndex) && <DownloadBundleProgress appDid={appDid} />}
          </WaiterContainer>
        )}
      </div>
      {/* Render this early to make sure websocket connected */}
      {state.isConnectOpen && <DownloadBundleProgress appDid={appDid} visible={false} />}
      <Connect
        open={state.isConnectOpen}
        popup
        autoConnect={!isDebosLaunchLoginConnect}
        saveConnect={false}
        className="connect"
        baseUrl={state.connectData.baseUrl}
        action={didConnectAction}
        checkFn={state.connectData.checkFn}
        extraParams={extraParams}
        forceConnected={false}
        checkTimeout={10 * 60 * 1000}
        webWalletUrl={getWebWalletUrl(info)}
        onSuccess={handleConnectSuccess}
        onClose={() => setState({ isConnectOpen: false })}
        locale={locale}
        messages={{
          title: `${t('launchBlocklet.dialog.title')}`,
          scan: getAuthDialogDescription(isFree, authMethod, t),
          confirm: t('launchBlocklet.dialog.confirm'),
          success: t('launchBlocklet.dialog.success'),
        }}
        customItems={
          isDebosLaunchLoginConnect
            ? [<DebosGoogleLogin key="google" extraParams={extraParams} onSuccess={handleConnectSuccess} />]
            : [
                <WithoutWallet
                  onClick={isFromLauncher ? handleLaunchBlockletByLauncher : handleLaunchBlockletWithoutWallet}
                />,
              ]
        }
      />
    </Container>
  );
}

const Container = styled(ContentLayout)`
  .body {
    align-items: center;
    animation: fadein ease 0.3s;
  }

  .illustrations {
    display: flex;
    flex-direction: row;
    justify-content: center;
    align-items: start;
    text-align: center;
    margin-top: 16px;
    margin-bottom: 40px;
    width: 100%;
  }

  .ills-block,
  .ills-block-inner {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    flex-shrink: 0;
    flex: 1;
  }
  .ills-block {
    max-width: 220px;
    .i-icon {
      width: 64px;
      height: 64px;
    }

    .i-name {
      margin-top: 16px;
      font-weight: 400;
      font-size: 16px;
      color: ${({ theme }) => theme.palette.text.primary};
    }

    .i-sub-name {
      color: ${({ theme }) => theme.palette.grey[400]};
    }
  }

  .arrow-icon {
    align-self: start;
    color: ${({ theme }) => theme.palette.grey[200]};
    font-size: 30px;
    margin: 16px 0 0;
    ${props => props.theme.breakpoints.down('md')} {
      margin: 25px 24px 0;
    }
  }

  @keyframes fadein {
    0% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }
`;

const ErrorMessageSub = styled.div`
  line-height: 1.4em;
  .error-desc {
    margin-top: 8px;
    word-wrap: break-word;
    color: ${props => props.theme.palette.grey[500]};
  }
`;

const ButtonContainer = styled.div`
  display: flex;
  justify-content: space-around;
  flex-wrap: wrap;
  button {
    margin: 0 10px 18px;
  }
`;

const ResultMessage = styled(LauncherResultMessage)`
  .result-footer {
    height: auto;
  }
`;
