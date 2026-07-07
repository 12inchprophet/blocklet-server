import { useState } from 'react';
import PropTypes from 'prop-types';
import { joinURL } from 'ufo';
import pick from 'lodash/pick';
import uniqBy from 'lodash/uniqBy';
import flatten from 'lodash/flatten';

import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import SchemaForm from '@abtnode/ux/lib/schema-form';
import Toast from '@arcblock/ux/lib/Toast';
import CompactLayout from '@blocklet/launcher-layout/lib/compact-layout';

import PageHeader from '@blocklet/launcher-layout/lib/page-header';

import { getAppMissingConfigs, forEachChildSync } from '@blocklet/meta/lib/util';
import {
  BLOCKLET_CONFIGURABLE_KEY,
  BlockletGroup,
  BLOCKLET_AUTOMATIC_ENV_VALUE_REGEX,
  BLOCKLET_AUTOMATIC_ENV_VALUE,
} from '@blocklet/constant';

import { DEBOS_BLOCKLET_DID, WELLKNOWN_SERVICE_PATH_PREFIX } from '@abtnode/constant';
import { useNodeContext } from '../../contexts/node';
import { useBlockletContext } from '../../contexts/blocklet';
import Layout from './layout';
import StepActions from './step-actions';
import Button from './button';

export default function Config({ onNext = () => {}, onPrevious = () => {}, buttonText = '' }) {
  const { t } = useLocaleContext();
  const [loading, setLoading] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const { did, blocklet, actions, env } = useBlockletContext();
  const { prefix, getSessionInHeader } = useNodeContext();

  let selfConfigs = (blocklet.configs || []).filter((x) => !BLOCKLET_CONFIGURABLE_KEY[x.key]);
  const customColor = blocklet.environments.find((x) => x.key === 'BLOCKLET_PASSPORT_COLOR');
  const logoUrl = joinURL(WELLKNOWN_SERVICE_PATH_PREFIX, `/blocklet/logo?v=${blocklet?.updatedAt}`);

  const configurableEnvs = [
    {
      key: BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_LOGO_SQUARE,
      description: t('blocklet.config.logoSquare'),
      value: blocklet.environments.find((x) => x.key === 'BLOCKLET_APP_LOGO_SQUARE')?.value,
      componentType: 'uploader',
      skipButtonDisabled: true,
      solo: true,
      componentProps: {
        url: logoUrl,
        height: 120,
        width: 120,
        type: 'square',
        did,
        prefix,
        headers: getSessionInHeader,
        onUploaded: actions.refreshBlocklet,
      },
    },
    {
      key: BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_NAME,
      description: t('blocklet.config.name'),
      value: blocklet.environments.find((x) => x.key === 'BLOCKLET_APP_NAME').value,
    },
    {
      key: BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_APP_DESCRIPTION,
      description: t('blocklet.config.description'),
      value: blocklet.environments.find((x) => x.key === 'BLOCKLET_APP_DESCRIPTION').value,
    },
    {
      key: BLOCKLET_CONFIGURABLE_KEY.BLOCKLET_PASSPORT_COLOR,
      description: t('blocklet.config.passportColor'),
      value: customColor ? customColor.value : 'auto',
      hidden: true,
      componentType: 'passport',
      componentProps: {
        blocklet,
      },
    },
  ];

  const childrenConfigs = [];
  forEachChildSync(blocklet, (b, { ancestors }) => {
    const ancestorDids = ancestors.slice(1).map((x) => x.meta.did);

    childrenConfigs.push((b.configs || []).map((x) => ({ ...x, childDid: ancestorDids.concat(b.meta.did) })));
  });

  if (blocklet.meta.group === BlockletGroup.gateway) {
    // 过滤掉如果容器中有无法传递给组件的配置
    // FIXME:: 暂时约定: 如果容器公开了配置项, 组件中相同的配置项 **必须是公开的** 且 **不能有默认值**
    selfConfigs = selfConfigs.filter((x) => !x.secure && x.shared);
  }
  const filteredConfigs = uniqBy(flatten([...selfConfigs, ...childrenConfigs]), 'key').filter((x) => !!x.key);

  const sortedConfig = filteredConfigs.sort((a, b) => {
    if (a.required && !b.required) {
      return -1;
    }

    if (b.required && !a.required) {
      return 1;
    }

    return 0;
  });

  const searchParams = new URLSearchParams(window.location.search);
  const isLauncherSetup =
    searchParams.get('__start__') === '1' || searchParams.has('setupToken') || searchParams.has('fromLauncher');
  const isDebos =
    [did, blocklet?.meta?.did, blocklet?.appPid].filter(Boolean).includes(DEBOS_BLOCKLET_DID) ||
    env?.componentId?.split('/').includes(DEBOS_BLOCKLET_DID);
  const setupConfigs = isLauncherSetup && isDebos ? sortedConfig.filter((item) => item.required) : sortedConfig;

  const missingRequiredConfigs = getAppMissingConfigs(blocklet).length;

  const onSubmitConfig = async (value) => {
    const { childDid, ...config } = editingItem;

    const configs = [
      {
        ...pick(config, ['key', 'value', 'description']),
        value,
      },
    ];

    try {
      setLoading(true);
      await actions.configBlocklet({
        configs,
        childDid,
      });
    } catch (err) {
      Toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const defaultValue = {};

  const schemaList = [...configurableEnvs, ...setupConfigs]
    .reduce((acc, item) => {
      const { value, ...rest } = item;
      defaultValue[item.key] = value;

      // 如果符合以下条件, 则不显示
      const matches = value ? value.match(BLOCKLET_AUTOMATIC_ENV_VALUE_REGEX) : null;
      if (matches !== null || value === BLOCKLET_AUTOMATIC_ENV_VALUE) {
        // 查找或创建 collapse 组件
        let collapseComponent = acc.find((x) => x.componentType === 'collapse');
        if (!collapseComponent) {
          collapseComponent = {
            key: 'BLOCKLET_CONFIG_COLLAPSE',
            description: t('blocklet.config.advanced'),
            componentType: 'collapse',
            children: [],
          };
        }
        // 如果是正则匹配, 则隐藏该配置项
        if (matches !== null) {
          rest.hidden = true;
        }
        collapseComponent.children.push({ ...rest });
        // 返回不包含 collapse 组件的数组，并在末尾添加更新后的 collapse 组件
        return [...acc.filter((x) => x.componentType !== 'collapse'), collapseComponent];
      }

      acc.push({ ...rest });
      return acc;
    }, [])
    .map((item) => {
      if (item.componentType === 'collapse') {
        // 检查所有子元素是否都隐藏
        const allChildrenHidden = item.children.every((child) => child.hidden === true);
        return {
          ...item,
          hidden: allChildrenHidden,
        };
      }
      return item;
    });

  const clickBack = () => {
    onPrevious();
  };

  return (
    <Layout>
      <div className="header" style={{ marginBottom: 16 }}>
        <PageHeader title={t('setup.config.title')} subTitle={t('setup.config.subTitle')} onClickBack={clickBack} />
      </div>
      <div className="container-main">
        <div className="container-inner">
          <CompactLayout
            bottom={
              <StepActions
                mt={8}
                disabled={loading || editingItem}
                blocklet={blocklet}
                onStartNow={() => onNext('complete')}>
                <Button
                  variant="contained"
                  disabled={loading || missingRequiredConfigs || editingItem}
                  onClick={() => {
                    actions.refreshFuel({ showError: false });
                    onNext();
                  }}>
                  {buttonText || t('setup.next')}
                </Button>
              </StepActions>
            }>
            <SchemaForm
              style={{ margin: '0 auto 20px' }}
              loading={loading}
              schema={schemaList}
              defaultValue={defaultValue}
              onChange={(changeValue, { action, currentItem }) => {
                if (action === 'edit') {
                  setEditingItem(currentItem);
                } else if (['cancel', 'confirm'].includes(action)) {
                  setEditingItem(null);
                }
                if (action === 'confirm') {
                  onSubmitConfig(changeValue[currentItem.key]);
                }
              }}
            />
          </CompactLayout>
        </div>
      </div>
    </Layout>
  );
}

Config.propTypes = {
  buttonText: PropTypes.string,
  onNext: PropTypes.func,
  onPrevious: PropTypes.func,
};
