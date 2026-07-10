// eslint-disable-next-line global-require
const logger = require('@abtnode/logger')(`${require('../../package.json').name}:launch`);
const { updateLaunchRecord } = require('@abtnode/auth/lib/debos-launch-guard');
const { getStatusFromError } = require('@blocklet/error');

const mutateBlockletPermission = require('../middlewares/mutate-blocklet-permission');

module.exports = {
  init(app, node) {
    const ensurePermission = mutateBlockletPermission(node);
    app.post('/api/launch/:sessionId', ensurePermission, async (req, res) => {
      try {
        const session = node.getSession ? await node.getSession({ id: req.params.sessionId }).catch(() => null) : null;
        await node.endSession({ id: req.params.sessionId });
        await updateLaunchRecord({
          node,
          sessionId: req.params.sessionId,
          appDid: session?.appDid,
          status: 'installed',
        });
        logger.info('Complete install for blocklet', { sessionId: req.params.sessionId });
        res.json({ sessionId: req.params.sessionId });
      } catch (err) {
        console.error('install blocklet failed', err);
        res.status(getStatusFromError(err)).json({ error: err.message });
      }
    });
  },
};
