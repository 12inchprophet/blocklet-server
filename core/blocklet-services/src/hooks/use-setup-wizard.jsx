import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { joinURL } from 'ufo';

import { DEBOS_BLOCKLET_DID, WELLKNOWN_BLOCKLET_ADMIN_PATH, WELLKNOWN_SERVICE_PATH_PREFIX } from '@abtnode/constant';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import { setVisitorId } from '@arcblock/ux/lib/Util';
import { BLOCKLET_APP_SPACE_REQUIREMENT, BLOCKLET_CONFIGURABLE_KEY } from '@blocklet/constant';
import getSafeUrlWithToast from '@abtnode/ux/lib/util/get-safe-url';
import useServerLogo from '@abtnode/ux/lib/hooks/use-server-logo';

import { useBlockletContext } from '../contexts/blocklet';
import { useSessionContext } from '../contexts/session';
import { PREFIX, getFromQuery, hasRequiredEnvironments, saveServerUrl } from '../util';

export default function useSetupWizard(
  basePath = `${WELLKNOWN_SERVICE_PATH_PREFIX}/setup`,
  showBranding = false,
  onFinish = null
) {
  const { t } = useLocaleContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { meta, blocklet, actions, launcherSession, env } = useBlockletContext();
  const serverUrl = localStorage.getItem('blocklet-server-url');
  const { session } = useSessionContext();

  const storageEndpoint = blocklet?.environments?.find(
    (item) => item.key === BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_SPACE_ENDPOINT
  )?.value;

  const logo = useServerLogo({
    onClick: () => {
      window.open(getSafeUrlWithToast(serverUrl, { allowDomains: null }));
    },
  });

  const fromLauncher = getFromQuery('fromLauncher');
  const launcherUrl = getFromQuery('launcherUrl');
  const launchType = getFromQuery('launchType');
  const visitorId = getFromQuery('visitorId');

  if (visitorId) {
    setVisitorId(visitorId);
    searchParams.delete('visitorId');
    setSearchParams(searchParams);
  }

  useEffect(() => {
    saveServerUrl();

    if (!session.user) {
      return;
    }

    actions?.refreshMeta();
    actions?.refreshBlocklet({ showError: false });
  }, [session.user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    actions.refreshFuel({ showError: false });
  }, [blocklet?.meta?.did]); // eslint-disable-line react-hooks/exhaustive-deps

  // 生成步骤配置
  const getDidSpacesStep = (blockletState) => {
    const didSpaceAbility = blockletState?.capabilities?.didSpace;

    if (!didSpaceAbility) {
      return null;
    }

    if (
      didSpaceAbility === BLOCKLET_APP_SPACE_REQUIREMENT.REQUIRED ||
      didSpaceAbility === BLOCKLET_APP_SPACE_REQUIREMENT.REQUIRED_ON_SETUP
    ) {
      return {
        key: 'did-space',
        stepTitle: t('setup.steps.didSpace'),
        name: (
          <>
            {t('setup.steps.didSpace')} <span className="required">*</span>
          </>
        ),
        path: joinURL(basePath, 'did-space'),
        description: t('setup.didSpace.subTitle'),
        getButtonDisabled: () => !storageEndpoint,
      };
    }

    if (didSpaceAbility === BLOCKLET_APP_SPACE_REQUIREMENT.OPTIONAL) {
      return {
        key: 'did-space',
        stepTitle: t('setup.steps.didSpace'),
        name: <>{t('setup.steps.didSpace')}</>,
        path: joinURL(basePath, 'did-space'),
        description: t('setup.didSpace.subTitle'),
        getButtonDisabled: () => false,
      };
    }
    console.warn(`capabilities.didSpace cannot take the value ${didSpaceAbility}`);
    return null;
  };

  const getAigneStep = () => {
    const { requirements } = meta;

    return {
      key: 'aigne',
      stepTitle: t('setup.steps.aigne'),
      name: (
        <>
          {t('setup.aigne.title')} {requirements?.aigne && <span className="required">*</span>}
        </>
      ),
      path: joinURL(basePath, 'aigne'),
      description: t('setup.aigne.subTitle'),
    };
  };

  const defaultSteps = [
    {
      key: 'bind-account',
      stepTitle: t('setup.steps.connect'),
      name: t('setup.connectAccount.title'),
      path: joinURL(basePath, 'bind-account'),
      description: t('setup.connectAccount.subTitle'),
    },
    {
      key: 'access',
      stepTitle: t('setup.steps.access'),
      name: t('setup.accessControl.title'),
      path: joinURL(basePath, 'access'),
      description: t('setup.accessControl.subTitle'),
    },
    getAigneStep(),
    {
      key: 'domain',
      stepTitle: t('setup.steps.domain'),
      name: t('setup.domain.title'),
      path: joinURL(basePath, 'domain'),
      description: t('setup.domain.subTitle'),
    },
    getDidSpacesStep(blocklet),
    showBranding
      ? {
          key: 'branding',
          stepTitle: t('setup.steps.branding'),
          name: t('setup.branding.title'),
          path: joinURL(basePath, 'branding'),
          description: t('setup.branding.subTitle'),
        }
      : {
          key: 'config',
          stepTitle: t('setup.steps.config'),
          name: (
            <>
              {t('setup.steps.config')} {hasRequiredEnvironments(meta) && <span className="required">*</span>}
            </>
          ),
          path: joinURL(basePath, 'config'),
          description: t('setup.config.subTitle'),
        },
    meta?.requirements?.fuels?.length
      ? {
          key: 'fuel',
          stepTitle: t('setup.steps.fuel'),
          name: (
            <>
              {t('setup.steps.fuel')} <span className="required">*</span>
            </>
          ),
          path: joinURL(basePath, 'fuel'),
          description: t('setup.fuel.subTitle'),
        }
      : null,
  ].filter(Boolean);

  const isLauncherSetup =
    searchParams.get('__start__') === '1' || searchParams.has('setupToken') || Boolean(fromLauncher);
  const isDebos =
    [meta?.did, blocklet?.meta?.did, blocklet?.appPid].filter(Boolean).includes(DEBOS_BLOCKLET_DID) ||
    env?.componentId?.split('/').includes(DEBOS_BLOCKLET_DID);
  const isStreamlinedDebosSetup = isLauncherSetup && isDebos;

  // DeBOS instances are fully provisioned by the launcher. Keep first-run onboarding focused on
  // naming the instance and confirming required values; integrations remain available in Dashboard.
  const steps = isStreamlinedDebosSetup ? defaultSteps.filter((step) => step.key === 'config') : defaultSteps;

  useEffect(() => {
    if (!isStreamlinedDebosSetup) {
      return;
    }

    const currentStep = window.location.pathname.split('/').filter(Boolean).pop();
    const skippedSteps = ['bind-account', 'access', 'aigne', 'domain', 'did-space', 'branding', 'fuel'];
    if (skippedSteps.includes(currentStep)) {
      navigate(`${joinURL(basePath, 'config')}${window.location.search}`, { replace: true });
    }
  }, [basePath, isStreamlinedDebosSetup, navigate]);

  const stepIndex = steps.findIndex(
    (x) => `${PREFIX.replace(/\/$/, '')}${basePath}/${x.key}` === window.location.pathname
  );

  const logoUrl = joinURL(PREFIX, WELLKNOWN_SERVICE_PATH_PREFIX, `/blocklet/logo?v=${blocklet?.updatedAt}`);

  // 导航方法
  const onNext = async (key) => {
    const { search } = new URL(window.location.href);
    const currentStep = steps[stepIndex];
    if (search.includes('from=empty') && currentStep.key === 'config') {
      window.open(getSafeUrlWithToast(`${joinURL(WELLKNOWN_BLOCKLET_ADMIN_PATH, '/overview/components')}${search}`));
      return;
    }

    if (!key) {
      if (steps[stepIndex + 1]) {
        navigate(`${joinURL(basePath, steps[stepIndex + 1].key)}${search}`);
      } else if (onFinish) {
        onFinish();
      } else {
        navigate(`${joinURL(basePath, 'complete')}${search}`);
      }
    } else {
      const index = steps.findIndex((x) => x.key === key);
      if (index > -1) {
        navigate(`${joinURL(basePath, steps[index].key)}${search}`);
      } else if (onFinish) {
        onFinish();
      } else {
        navigate(`${joinURL(basePath, 'complete')}${search}`);
      }
    }

    await actions.refreshBlocklet();
  };

  const onStepClick = (stepKey) => {
    const { search } = new URL(window.location.href);
    navigate(`${joinURL(basePath, stepKey)}${search}`);
  };

  const onPrevious = () => {
    navigate(-1);
  };

  // 生成总步骤（包含安装等）
  const commonSteps = [
    {
      key: 'install',
      name: t('launchBlocklet.steps.installApp'),
      path: joinURL(basePath, 'install'),
    },
    {
      key: 'setup',
      name: t('setup.steps.launchApp'),
      children: steps,
    },
  ];

  let totalSteps = [
    {
      key: 'agreement',
      name: t('launchBlocklet.introduction'),
      path: joinURL(basePath, 'agreement'),
    },
    ...commonSteps,
  ];

  if (fromLauncher) {
    totalSteps = [
      {
        key: 'purchase-space',
        name: t('launchBlocklet.steps.purchaseSpace'),
      },
      {
        key: 'prepare-space',
        name: t('launchBlocklet.steps.prepareSpace'),
      },
      ...commonSteps,
    ];
  }

  return {
    // 数据
    meta,
    blocklet,
    actions,
    launcherSession,
    session,
    steps,
    stepIndex,
    totalSteps,

    // 配置
    fromLauncher,
    launcherUrl,
    launchType,
    logoUrl,
    logo,
    t,

    // 方法
    onNext,
    onPrevious,
    onStepClick,
  };
}
