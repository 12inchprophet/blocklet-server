# DeBOS Launch Authorization

This fork preserves the default Blocklet Server authorization behavior and adds one narrow exception:

- owners and admins keep their existing launch permissions;
- an approved, authenticated guest may launch only the DeBOS Blocklet DID
  `z8iZzXUyiJYiDZP3nhMVMN3eeXnZZ6dokUk2B`;
- anonymous requests, unapproved users, and guest launches for every other Blocklet remain denied.

## Authorization path

1. The Store sends the user to the server's `launch-blocklet/install` page with a
   `blocklet_meta_url`.
2. The server fetches the metadata itself. It does not trust a DID supplied by the browser.
3. The normal owner/admin wallet and passport paths remain available.
4. For DeBOS only, the launch page can authenticate a new user through:
   - the existing ArcBlock wallet/passkey flow; or
   - the server-local Google OAuth flow when it is configured.
5. Google OAuth creates or reuses an approved guest account whose DID is deterministically
   derived from the Google subject and the server key. The Google subject is not accepted from
   the browser.
6. The server issues a signed guest token scoped with `purpose=debos-launch` and the canonical
   DeBOS DID. A generic guest session is not accepted by the launch-only server routes.
7. The launch authorization check permits a session-authenticated, approved user only when the
   fetched Blocklet metadata DID equals the DeBOS DID.
8. The existing installation and app-owner setup path creates the launched DeBOS instance and
   records the authenticated user as its owner.
9. Existing server and Blocklet audit logs remain in place. Google authentication additionally
   records `login-debos-launch`, the provider, user DID, and DeBOS DID.

## Security boundaries

- The exception is checked against server-fetched metadata, not a title, URL substring, or
  client-provided DID.
- OAuth state is HMAC-signed, expires after ten minutes, and is bound to the initiating origin.
- The callback exchanges the Google authorization code on the server; the client secret is never
  sent to the browser.
- Google login is fail-closed and hidden from the UI unless both credentials are configured.
- The Google route rejects non-DeBOS metadata before creating a session.
- Launch guests are denied access to ordinary server dashboard routes, even if they forge a
  launch-page `Referer` header.
- Re-entry grants are random, stored only as hashes, expire after two minutes, and can be consumed
  only once by the intended DeBOS app DID.
- OAuth popup callbacks must use the actual target DeBOS origin and the fixed callback path.
- Temporary grants contain only identifiers needed for authorization; Google profile data is not
  copied into the grant.
- Existing owner/admin authorization is unchanged.

## Google configuration

Create an OAuth 2.0 **Web application** in Google Cloud and add this exact authorized redirect URI
for the current local dev server:

```text
https://192-168-1-12.ip.abtnet.io:18444/.well-known/server/admin/oauth/debos-launch/callback/google
```

Expose these variables to the Blocklet Server service process and restart the service:

```text
DEBOS_GOOGLE_CLIENT_ID
DEBOS_GOOGLE_CLIENT_SECRET
DEBOS_GOOGLE_BROKER_URL
```

When the Google consent screen is in Testing mode, add each test Google account as a test user.
Production deployment must use the production HTTPS origin as a separate authorized redirect URI.

## Test plan

Automated coverage:

1. Existing owner/admin launch tests continue to pass.
2. An approved session guest can launch DeBOS.
3. The same guest cannot launch a different Blocklet DID.
4. An anonymous or unapproved user cannot use the exception.
5. The OAuth config endpoint never exposes the client secret.
6. A valid Google response creates an approved guest and audit event.
7. Non-DeBOS metadata and tampered OAuth state are rejected.
8. A generic guest token cannot access server dashboard APIs or impersonate a launch-scoped guest.
9. A re-entry popup callback for any origin other than the target DeBOS instance is rejected.

Manual end-to-end test:

1. Open the Store in a clean browser profile.
2. Select DeBOS and choose Launch.
3. Confirm that `Continue with Google` appears alongside the existing ArcBlock options.
4. Sign in using a Google test account that has never joined this server.
5. Complete the launch and verify the new DeBOS instance is running.
6. Open the new instance and verify that the Google user has its owner credentials.
7. In the server Team view, verify the Google identity is a guest rather than a server owner/admin.
8. In Audit Trail, verify the Google login and launch/install actions.
9. Attempt to substitute metadata for another Blocklet and verify a `403` denial.
10. Repeat with the original server owner and verify the owner path still works unchanged.

## Primary implementation files

- `core/constant/src/blocklet.js`: canonical DeBOS DID.
- `core/auth/lib/server.js`: narrow approved-session/DeBOS authorization exception.
- `core/webapp/api/routes/auth/login-debos-launch.js`: wallet/passkey launch login guard.
- `core/webapp/api/routes/auth/google-debos-launch.js`: Google OAuth and guest session creation.
- `core/webapp/src/components/launch-blocklet/step-install.jsx`: launch login choices.
- `core/state/lib/util/launcher.js`: preserves the authenticated provider while assigning app ownership.
