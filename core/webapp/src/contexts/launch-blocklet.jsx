/* eslint-disable no-shadow */
import { createContext, useState, useContext, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import { BlockletStatus } from '@blocklet/constant';
import { getServerUrl } from '@abtnode/ux/lib/blocklet/util';
import Toast from '@arcblock/ux/lib/Toast';
import { SERVER_ROLES } from '@abtnode/constant';

import { useSessionContext } from './session';
import { useNodeContext } from './node';
import { authorize } from '../components/launch-blocklet/util';

const LaunchBlockletContext = createContext({});
const { Provider, Consumer } = LaunchBlockletContext;

// eslint-disable-next-line react/prop-types
function LaunchBlockletProvider({ children }) {
  const { session } = useSessionContext();
  const { t } = useLocaleContext();
  const { api, info } = useNodeContext();
  const [params] = useSearchParams();

  const launchType = params.get('launchType');
  const fromLauncher = params.get('fromLauncher');
  const blockletMetaUrl = params.get('blocklet_meta_url') || '';
  const nftId = params.get('nftId') || '';
  const from = params.get('from') || '';
  const launcherSessionId = params.get('launcherSessionId') || '';
  const launcherUrl = params.get('launcherUrl') || '';

  const installFromUrl = from === 'url';
  // 创建 empty blocklet
  const isEmptyBlocklet = from === 'empty';

  const storeUrl = installFromUrl || isEmptyBlocklet ? '' : new URL(blockletMetaUrl).origin;

  const [state, setState] = useState({
    meta: null,
    appDid: params.get('appDid') || null,
    sessionId: params.get('sessionId') || null,
    isFree: true,
    isExternal: false,
    isInstalling: false,
    isInstalled: false,
    isRunning: false,
    launcherSession: null,
    registryUrl: '',
  });
  const setAppDid = (appDid, sessionId) => setState(x => ({ ...x, appDid, sessionId }));

  const isAuthorized = authorize({ user: session.user, launchType, nftId, blockletDid: state.meta?.did });

  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const serverUrl = useMemo(() => (info ? getServerUrl(info) : ''), [info]);

  const getBlocklet = async appDid => {
    if (!appDid) {
      throw new Error('appDid should not be empty');
    }

    const { blocklet } = await api.getBlocklet({
      input: { did: appDid, attachConfig: false },
    });

    if (!blocklet) {
      return null;
    }

    const statusCode = BlockletStatus[blocklet.status];
    const isExternal = !!nftId;
    const isInstalling = statusCode < BlockletStatus.installed;
    const isInstalled = statusCode === BlockletStatus.installed;
    const isRunning = statusCode === BlockletStatus.running;

    setState(x => ({ ...x, isInstalled, isRunning, isExternal, isInstalling }));

    return { isInstalled, isRunning, isExternal, isInstalling };
  };

  const getMeta = async () => {
    setLoading(true);
    if (isEmptyBlocklet) {
      setState(x => ({
        ...x,
        meta: {
          title: params.get('title') || '',
          description: params.get('description') || '',
        },
      }));
      setLoading(false);
      return;
    }

    try {
      if (!blockletMetaUrl && !isEmptyBlocklet) {
        throw new Error(t('common.invalidParam'));
      }

      const [{ meta, isFree, registryUrl }, { launcherSession, error }] = await Promise.all([
        api.getBlockletMetaFromUrl({ input: { url: blockletMetaUrl, checkPrice: true } }),
        launcherSessionId ? api.getLauncherSession({ input: { launcherSessionId, launcherUrl } }) : Promise.resolve({}),
      ]);

      if (launcherSessionId && !launcherSession) {
        throw new Error(`Launch session invalid: ${error}`);
      }

      if (!meta) {
        throw new Error(t('LaunchBlockletBlocklet.error.loadMetaFailed'));
      }

      let blocklet = {};
      if (isAuthorized && state.appDid) {
        blocklet = await getBlocklet(state.appDid);
      }

      setState(x => ({ ...x, ...blocklet, meta, isFree, registryUrl, launcherSession }));
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // EXTERNAL_BLOCKLET_CONTROLLER should auto logout at initial
    if (
      session?.user?.role === SERVER_ROLES.EXTERNAL_BLOCKLET_CONTROLLER &&
      session?.user?.controller?.nftId !== nftId
    ) {
      session.logout();
    }

    getMeta();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (loading || !state.meta) {
      return;
    }

    if (!isAuthorized) {
      setState(x => ({ ...x, isInstalled: false, isRunning: false, isExternal: false }));
      setError(null);
    } else if (state.appDid) {
      getBlocklet(state.appDid).catch(err => {
        Toast.error(err.message);
      });
    }
  }, [isAuthorized]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    meta: state.meta,
    isFree: state.isFree,
    appDid: state.appDid,
    sessionId: state.sessionId,
    isInstalling: state.isInstalling,
    isInstalled: state.isInstalled,
    isExternal: state.isExternal,
    isRunning: state.isRunning,
    serverUrl,
    storeUrl: state.registryUrl || storeUrl,
    blockletMetaUrl,
    fromLauncher,
    loading,
    error,
    api,
    getBlocklet,
    setAppDid,
    launcherUrl,
    launcherSession: state.launcherSession,
    launcherSessionId,
    launchType,
  };

  return <Provider value={value}>{children}</Provider>;
}

function useLaunchBlockletContext() {
  return useContext(LaunchBlockletContext);
}

export { LaunchBlockletContext, LaunchBlockletProvider, Consumer as LaunchBlockletConsumer, useLaunchBlockletContext };
