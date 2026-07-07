import { useBlockletContext } from '@abtnode/ux/lib/contexts/blocklet';
import DidConnect from '@arcblock/did-connect-react/lib/Connect';
import { useLocaleContext } from '@arcblock/ux/lib/Locale/context';
import PageHeader from '@blocklet/launcher-layout/lib/page-header';
import AdminPanelSettingsIcon from '@iconify-icons/material-symbols/admin-panel-settings';
import CheckCircleIcon from '@iconify-icons/material-symbols/check-circle';
import KeyIcon from '@iconify-icons/material-symbols/key';
import EmailIcon from '@iconify-icons/material-symbols/mail-outline';
import WalletIcon from '@iconify-icons/material-symbols/wallet';
import { Icon } from '@iconify/react';
import { Alert, alpha, Box, Tooltip, Typography, useTheme } from '@mui/material';
import PropTypes from 'prop-types';
import { useEffect, useRef, useState } from 'react';

import { PasskeyActions } from '@arcblock/did-connect-react/lib/Passkey';
import DID from '@arcblock/ux/lib/DID';
import { useSessionContext } from '../../contexts/session';
import { getWebWalletUrl } from '../../util';
import Button from './button';
import Layout from './layout';
import StepActions from './step-actions';

// 账户类型配置
const getAccountTypes = (t) => ({
  wallet: {
    icon: WalletIcon,
    label: t('setup.connectAccount.wallet'),
    description: t('setup.connectAccount.walletDesc'),
    isDefault: false,
    priority: 1,
  },
  passkey: {
    icon: KeyIcon,
    label: t('setup.connectAccount.passkey'),
    description: t('setup.connectAccount.passkeyDesc'),
    isDefault: false,
    priority: 2,
  },
  google: {
    icon: EmailIcon,
    label: 'Google',
    description: 'Google account login',
    isDefault: true,
    priority: 3,
  },
  email: {
    icon: EmailIcon,
    label: t('setup.connectAccount.email'),
    description: t('setup.connectAccount.emailDesc'),
    isDefault: true,
    priority: 4,
  },
});

function AccountCard({ type, account = null, onBind, bindButton = null, loading = false, recommended = false }) {
  const { t } = useLocaleContext();
  const config = getAccountTypes(t)[type];
  const isConnected = !!account;
  const theme = useTheme();

  return (
    <Box
      sx={{
        mb: 2,
        p: { xs: 1.5, sm: 2 },
        border: 1,
        borderColor: recommended ? alpha(theme.palette.primary.main, 0.2) : 'divider',
        borderRadius: 1,
        bgcolor: recommended ? alpha(theme.palette.primary.main, 0.08) : 'background.paper',
      }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          flexDirection: { xs: 'column', sm: 'row' },
          gap: { xs: 1.5, sm: 2 },
        }}>
        {/* 移动端：图标和标题行 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            width: { xs: '100%', sm: 'auto' },
          }}>
          <Icon icon={config.icon} style={{ fontSize: '20px' }} />

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 500,
                  fontSize: { xs: '0.875rem', sm: '1rem' },
                }}>
                {config.label}
              </Typography>
              {isConnected && renderConnected('mobile')}
              {recommended && (
                <Typography
                  variant="caption"
                  sx={{
                    color: 'warning.main',
                    fontWeight: 500,
                    fontSize: '0.7rem',
                  }}>
                  {t('setup.connectAccount.recommended')}
                </Typography>
              )}
            </Box>

            {/* 移动端下显示详细信息 */}
            <Box sx={{ mt: 0.5 }}>{renderLabel(account)}</Box>
          </Box>
        </Box>

        {/* 按钮区域 */}
        {config.isDefault ? (
          renderConnected()
        ) : (
          <Box
            sx={{
              width: { xs: '100%', sm: 'auto' },
              display: 'flex',
              justifyContent: 'center',
            }}>
            {isConnected
              ? renderConnected()
              : bindButton || (
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => onBind(type)}
                    disabled={loading}
                    fullWidth={{ xs: true, sm: false }}
                    sx={{
                      borderColor: 'primary.main',
                      height: '32px !important',
                      minWidth: { xs: '100%', sm: '60px' },
                      fontSize: { xs: '0.875rem', sm: '0.8125rem' },
                    }}>
                    {t('setup.connectAccount.connect')}
                  </Button>
                )}
          </Box>
        )}
      </Box>
    </Box>
  );

  function renderLabel(accountInfo) {
    if (!isConnected) {
      return (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {config.description}
        </Typography>
      );
    }

    if (accountInfo.displayName === accountInfo.did) {
      return <DID did={accountInfo.did} showQrcode />;
    }

    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', mt: 0.5 }}>
        {accountInfo.displayName}
      </Typography>
    );
  }

  function renderConnected(device) {
    const isMobile = device === 'mobile';
    return (
      <Box
        sx={{
          minWidth: isMobile ? 'auto' : { xs: '100%', sm: '60px' },
          display: isMobile ? { xs: 'flex', md: 'none' } : { xs: 'none', md: 'flex' },
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <Tooltip title={t('setup.connectAccount.connected')} placement="top">
          <Icon
            icon={CheckCircleIcon}
            style={{ color: theme.palette.success.main, fontSize: isMobile ? '18px' : '24px' }}
          />
        </Tooltip>
      </Box>
    );
  }
}

AccountCard.propTypes = {
  type: PropTypes.string.isRequired,
  account: PropTypes.object,
  onBind: PropTypes.func.isRequired,
  bindButton: PropTypes.node,
  loading: PropTypes.bool,
  recommended: PropTypes.bool,
};

function ConnectAccount({ onNext = () => {}, onPrevious = () => {} }) {
  const { t } = useLocaleContext();
  const { blocklet } = useBlockletContext();
  const [loading, setLoading] = useState(false);
  const [showDidConnect, setShowDidConnect] = useState(false);
  const [currentBindType, setCurrentBindType] = useState(null);
  const { api, session } = useSessionContext();

  const passkeyRef = useRef(null);
  // 从 connectedAccounts 解析账户状态
  const getAccountsByType = () => {
    const connectedAccounts = session.user?.connectedAccounts || [];
    const result = {};

    connectedAccounts.forEach((account) => {
      const { provider, userInfo, did, id } = account;

      if (provider === 'email') {
        result.email = {
          did,
          displayName: id?.replace('email|', '') || session.user?.email,
          ...account,
        };
      } else if (provider === 'wallet') {
        result.wallet = {
          did,
          displayName: did,
          ...account,
        };
      } else if (provider === 'passkey') {
        result.passkey = {
          did,
          displayName: userInfo?.name || did,
          ...account,
        };
      } else if (provider === 'google') {
        result.google = {
          did,
          displayName: userInfo?.email || userInfo?.name || session.user?.email || id,
          ...account,
        };
      }
    });

    return result;
  };

  const [accounts, setAccounts] = useState(getAccountsByType());

  useEffect(() => {
    setAccounts(getAccountsByType());
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBind = (type) => {
    setCurrentBindType(type);
    setLoading(true);

    if (type === 'wallet') {
      setShowDidConnect(true);
    } else if (type === 'passkey') {
      passkeyRef.current.click();
      // Passkey 绑定通过 PasskeyActions 组件处理
    }
  };

  const handleBindSuccess = () => {
    // 重新解析 connectedAccounts（因为绑定成功后 session 会更新）
    session.refresh();
    setLoading(false);
    setShowDidConnect(false);
    setCurrentBindType(null);
  };

  // 计算推荐绑定
  const ACCOUNT_TYPES = getAccountTypes(t);
  const getRecommendedTypes = () => {
    const unbound = Object.keys(ACCOUNT_TYPES).filter((type) => !accounts[type] && !ACCOUNT_TYPES[type].isDefault);
    return unbound.slice(0, 2); // 推荐前两个未绑定的类型
  };

  const recommendedTypes = getRecommendedTypes();
  const boundCount = Object.values(accounts).filter(Boolean).length;

  return (
    <Layout>
      <div className="header">
        <PageHeader title={t('setup.connectAccount.title')} onClickBack={onPrevious} />
      </div>
      <Box
        className="form-container"
        sx={{
          maxWidth: '700px',
          px: { xs: 1, sm: 0 },
          width: '100%',
        }}>
        {/* 状态概览 */}

        {Object.entries(ACCOUNT_TYPES)
          .filter(([type, config]) => accounts[type] || !config.isDefault)
          .sort(([, a], [, b]) => a.priority - b.priority)
          .map(([type]) => (
            <AccountCard
              key={type}
              type={type}
              account={accounts[type]}
              onBind={handleBind}
              bindButton={
                type === 'passkey' ? (
                  <PasskeyActions
                    key="passkey"
                    behavior="only-new"
                    action="connect"
                    sx={{
                      height: '32px',
                      minWidth: { xs: '100%', sm: '60px' },
                      border: '1px solid',
                      borderColor: 'primary.main',
                      '& .MuiTypography-root': {
                        color: 'primary.main',
                        textAlign: 'center',
                        fontSize: { xs: '0.875rem', sm: '0.8125rem' },
                      },
                      '& > div:first-child': { display: 'none' },
                      '& > svg': { display: 'none !important' },
                    }}
                    createButtonText={t('setup.connectAccount.connect')}
                    createMode="connect"
                    onConnect={() => {
                      setLoading(true);
                      setCurrentBindType('passkey');
                    }}
                    onSuccess={() => {
                      handleBindSuccess();
                    }}
                    onError={() => {
                      setLoading(false);
                      setCurrentBindType(null);
                    }}
                    dense
                  />
                ) : null
              }
              loading={loading && currentBindType === type}
              recommended={recommendedTypes.includes(type)}
            />
          ))}

        {/* 安全建议 */}
        {boundCount === 1 ? (
          !!accounts.email && (
            <Alert severity="warning" sx={{ mt: -1 }}>
              <Typography variant="body2" sx={{ fontSize: { xs: '0.8rem', sm: '0.875rem' } }}>
                {t('setup.connectAccount.securityTip')}
              </Typography>
            </Alert>
          )
        ) : (
          <Alert severity="success" sx={{ mb: { xs: 2, sm: 3 } }} icon={<Icon icon={AdminPanelSettingsIcon} />}>
            <Typography variant="body2" sx={{ fontSize: { xs: '0.8rem', sm: '0.875rem' } }}>
              {t('setup.connectAccount.statusSuccess', { count: boundCount })}
            </Typography>
          </Alert>
        )}
        {/* DID Connect 弹窗 */}
        <DidConnect
          popup
          open={showDidConnect}
          action="bind-wallet"
          checkFn={api.get}
          checkTimeout={10 * 60 * 1000}
          webWalletUrl={getWebWalletUrl()}
          onClose={() => {
            setShowDidConnect(false);
            setLoading(false);
            setCurrentBindType(null);
          }}
          onSuccess={() => {
            handleBindSuccess();
          }}
          locale="zh"
          messages={{
            title: t('setup.connect.title'),
            scan: t('setup.connect.scan'),
            confirm: t('setup.connect.confirm'),
            success: t('setup.connect.success'),
          }}
          extraParams={{
            previousUserDid: session.user?.did,
            skipMigrateAccount: true,
            isService: true,
          }}
        />
      </Box>

      <StepActions blocklet={blocklet}>
        <Button variant="contained" onClick={() => onNext()} disabled={loading} sx={{ minWidth: { xs: 100, sm: 120 } }}>
          {boundCount > 0 ? t('setup.continue') : t('setup.connectAccount.skipBinding')}
        </Button>
      </StepActions>
    </Layout>
  );
}

ConnectAccount.propTypes = {
  onNext: PropTypes.func,
  onPrevious: PropTypes.func,
};

export default ConnectAccount;
