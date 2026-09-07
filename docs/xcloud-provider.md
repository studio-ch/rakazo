# Xcloud macOS provider

The Studio Rakazo-Xcloud distribution adds `SANDBOX_PROVIDER=xcloud` without
changing Rakazo's ownership model: Rakazo owns durable workspace state and control
leases; Xcloud owns the macOS computer, lifecycle, guest execution, files, and the
hypervisor-backed screen.

## Configuration

Create a dedicated Xcloud provider installation for the Rakazo tenant. Its API key
must contain only `computer:read`, `computer:use`, and `computer:manage`.

```env
SANDBOX_PROVIDER=xcloud
XCLOUD_API_URL=https://api.example.invalid
XCLOUD_SERVICE_TOKEN=replace-with-dedicated-provider-token
XCLOUD_REGION_ID=replace-with-region-id
XCLOUD_FLAVOR_SLUG=mac.small
XCLOUD_IMAGE_REF=replace-with-catalog-image
XCLOUD_NETWORK_REF=default
XCLOUD_ADMIN_USERNAME=admin
```

The API and worker need the same values. Docker Compose loads them from `.env` for
both services. Never put the service token in an image, source file, log, browser
configuration, or user-facing error message.

For the published Compose stack, also pin the Studio distribution:

```env
RAKAZO_IMAGE=ghcr.io/studio-ch/rakazo-xcloud
RAKAZO_IMAGE_TAG=v1.0.0
RAKAZO_UPDATER_IMAGE=ghcr.io/studio-ch/rakazo-xcloud-updater
RAKAZO_UPDATER_IMAGE_TAG=v1.0.0
```

The provider refuses to initialize until the API URL, service token, region,
flavor, and image are present. Network and admin username default to `default` and
`admin`.

## Runtime behavior

- `providerRef` is the stable Xcloud computer ID. VM replacement changes the
  internal instance ID and returns `fresh: true`; Rakazo then imports its durable
  workspace copy.
- Lifecycle and workspace transfers are persistent Xcloud operations and survive
  an API restart.
- Screen observation and input use the hypervisor framebuffer. No Screen Recording
  or Accessibility permission is required for that transport. Secure automatic
  login has separate guest-image requirements below.
- `prepare()` also waits for the intended macOS console user to finish logging in
  with an unlocked desktop. A healthy guest agent alone is not readiness.
- The viewer URL contains only a short-lived capability. The VNC password remains
  server-side.
- Xcloud enforces the active screen lease, interactive state, control token, and
  monotonically increasing fence before accepting input.
- macOS V1 exposes one graphical screen (`multiScreen: false`) and no PTY.

### macOS session preparation (development build)

Deploy the gateway's `POST /v1/xcloud/computers/:id/session/prepare` endpoint before
deploying this adapter revision. Older gateways fail closed; there is no fallback
that treats a login window as a ready computer.

The gateway generates a per-computer account password and uses its existing
encrypted password-provisioning worker. It waits for that password to be verified
inside the guest. Neither Rakazo configuration nor model tool output receives the
password. Existing provider computers without a managed password are initialized
through the same path when no screen controller is active.

An already-unlocked session needs no UI permissions. For automatic login or unlock,
the image must permit the guest automation runtime (`osascript`, launched by the
system guest agent) to use Accessibility and automate System Events. Its login
window must expose a secure text field and a confirm/default-button action. A
password-only cold login must identify the selected account by short name; an
ambiguous account picker is rejected. Qualify these permissions and controls in
the image build, not through runtime prompts or edits to the TCC database.

Login targets only Apple's loginwindow secure field. It never uses the clipboard
or global typing, disables FileVault or screen locking, logs out another user, or
reboots the machine. Active screen control permits readiness checks but prevents
login input. A failed submission is not repeated for the same credential until a
successful unlock clears the guard or the guest reboots. Password rotation also
allows a new attempt. Provisioning, unknown session state, and an in-progress
login remain pending; an unsafe/unavailable login surface reports a specific error.

Before releasing, verify a disposable image from both the logged-out and locked
states and confirm workspace commands start only after an unlocked session is
observed. Offline tests and the read-only native probe do not replace that VM
acceptance test. The compatibility table below describes the released baseline,
not acceptance of this development change.

## Compatibility

| Component | Supported version |
|---|---|
| Studio Rakazo-Xcloud distribution | `v1.0.0` |
| `@studio-ch/rakazo-xcloud-adapter` | `0.1.0` |
| Rakazo upstream | `a4ebad0cae4f9d0d3f6e7b3c30316b2bf6d924db` |
| Studio CP gateway | `v0.12.54` or newer |
| Xcloud guest agent | Process-group termination patch from `studio-ch/xcloud#25` or newer |
| Guest platform | macOS; Linux is intentionally outside this release |

The container image is `ghcr.io/studio-ch/rakazo-xcloud`. Production deployments
must pin a release tag or digest, never `edge`.

## Upgrade and rollback

Before upgrading, verify the compatibility table and run the adapter contract
tests. The weekly upstream-sync workflow opens a compatibility PR instead of moving
the upstream pin automatically.

An open `automation/xcloud-upstream-sync` PR pauses further sync attempts so that
manual conflict resolutions are preserved. Conflicting merges leave the remote
branch untouched and list the files needing resolution in the workflow summary.
The current integration branch also accepts upstream `spaceId` contexts and maps
them to Xcloud's `workspaceId` field; the released compatibility table above stays
unchanged until a macOS acceptance run passes.

Rollback by restoring the previous image digest. Existing `providerRef` values
remain valid as long as the target version supports the same adapter contract.

The immediate kill switch is:

```env
SANDBOX_PROVIDER=none
```

Restart the API and worker after changing it. This prevents new computer activity;
it does not delete existing Xcloud computers. Re-enable the previous pinned image
and `SANDBOX_PROVIDER=xcloud` to reconnect them.
