import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import noop from 'lodash/noop';
import { joinURL } from 'ufo';
import useAsync from 'react-use/lib/useAsync';
import { LOGIN_PROVIDER } from '@arcblock/ux/lib/Util/constant';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import DidConnect, { useSecurity } from '@arcblock/did-connect-react/lib/Connect';
import { CircularProgress, Typography } from '@mui/material';
import Center from '@arcblock/ux/lib/Center';
import Toast from '@arcblock/ux/lib/Toast';
import { styled } from '@mui/material/styles';
import { PasskeyActions } from '@arcblock/did-connect-react/lib/Passkey';

import { useSessionContext } from '../../contexts/session';
import { getWebWalletUrl, setSessionToken } from '../../util';

export default function Connect({ children, skipBindAccount = false }) {
  const { t, locale } = useLocaleContext();
  const { api, session } = useSessionContext();
  const { encryptKey, decrypt } = useSecurity();
  const [setupTokenHydration, setSetupTokenHydration] = useState('idle');

  const hasStartupSetupToken = useMemo(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get('__start__') === '1' && !!url.searchParams.get('setupToken');
  }, []);

  const shouldBindAccount = useMemo(() => {
    if (skipBindAccount) {
      return false;
    }
    if (!session.user) {
      return false;
    }
    const { sourceProvider, connectedAccounts = [] } = session.user;
    // 如果账户的 provider 只有 email，那么需要允许绑定其他账户
    // 1. server: Wallet, Passkey
    const allEmailAccount = connectedAccounts.every((x) => x.provider === LOGIN_PROVIDER.EMAIL);
    return sourceProvider === LOGIN_PROVIDER.EMAIL && allEmailAccount;
  }, [session.user, skipBindAccount]);

  const state = useAsync(async () => {
    // 只有当 shouldBindAccount 为 false 时才需要请求
    if (shouldBindAccount) {
      return null;
    }
    const nextUrl = new URL(window.location.href);
    nextUrl.pathname = joinURL(window?.env?.apiPrefix ?? '/', '/api/did/setup/token');
    nextUrl.searchParams.set('_ek_', encryptKey);
    const { data } = await api.get(nextUrl.href);
    return data;
  }, [shouldBindAccount]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSetupToken() {
      setSetupTokenHydration('loading');
      try {
        await session.refresh({ showProgress: false });
      } catch (error) {
        // If the setup token is stale or invalid, fall back to the DID/passkey pre-setup flow below.
        console.warn('Failed to hydrate setup token before setup connect', error); // eslint-disable-line no-console
      } finally {
        if (!cancelled) {
          setSetupTokenHydration('done');
        }
      }
    }

    if (
      !skipBindAccount &&
      hasStartupSetupToken &&
      !session.user &&
      !session.loading &&
      setupTokenHydration === 'idle'
    ) {
      hydrateSetupToken();
    }

    return () => {
      cancelled = true;
    };
  }, [hasStartupSetupToken, session.loading, session.user, setupTokenHydration, skipBindAccount]); // eslint-disable-line react-hooks/exhaustive-deps

  const onConnect = async (results) => {
    const result = Array.isArray(results) ? results.find((x) => x.sessionToken) : results;
    if (result.sessionToken) {
      setSessionToken(decrypt(result.sessionToken));
    }
    try {
      await session.refresh();
    } catch (err) {
      Toast.error(err.message);
    }
  };

  const waitingForStartupSetupToken =
    hasStartupSetupToken && !session.user && ['idle', 'loading'].includes(setupTokenHydration);

  if (!shouldBindAccount && (waitingForStartupSetupToken || !state.value || state.loading || session.loading)) {
    return (
      <Center relative="parent">
        <CircularProgress />
      </Center>
    );
  }

  if (!shouldBindAccount && state.error) {
    return (
      <Center relative="parent">
        <Typography>{state.error.message}</Typography>
      </Center>
    );
  }

  if (session.user && !shouldBindAccount) {
    return children;
  }

  return (
    <WrapConnect
      popup
      open
      hideCloseButton
      action={shouldBindAccount ? 'bind-wallet' : 'pre-setup'}
      checkFn={api.get}
      checkTimeout={10 * 60 * 1000}
      webWalletUrl={getWebWalletUrl()}
      onSuccess={onConnect}
      locale={locale}
      messages={{
        title: t('setup.connect.title'),
        scan: t('setup.connect.scan'),
        confirm: t('setup.connect.confirm'),
        success: t('setup.connect.success'),
      }}
      customItems={
        shouldBindAccount
          ? [
              <PasskeyActions
                key="passkey"
                behavior="only-new"
                action="connect"
                createMode="connect"
                onSuccess={onConnect}
                onError={noop}
                dense
              />,
            ]
          : []
      }
      extraParams={
        shouldBindAccount
          ? {
              previousUserDid: session.user?.did,
              visitorId: state.value?.visitorId,
              skipMigrateAccount: true,
              isService: true,
            }
          : { setup: true, nw: state.value.url }
      }
    />
  );
}

Connect.propTypes = {
  children: PropTypes.any.isRequired,
  skipBindAccount: PropTypes.bool,
};

const WrapConnect = styled(DidConnect)`
  .action-info-desc {
    padding: 0 72px;
  }
`;
