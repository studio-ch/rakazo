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
  or Accessibility permission is required inside macOS.
- The viewer URL contains only a short-lived capability. The VNC password remains
  server-side.
- Xcloud enforces the active screen lease, interactive state, control token, and
  monotonically increasing fence before accepting input.
- macOS V1 exposes one graphical screen (`multiScreen: false`) and no PTY.

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
