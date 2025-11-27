# RFC: Real-Time Resource Change Notifications

**Status:** Proposal
**Author:** SignalK Charts Provider Simple Plugin
**Date:** 2025-01-28
**Issue:** [To be created]

## API Version Clarification

This RFC refers to **SignalK v1 streaming protocol** (`/signalk/v1/stream`) which is the current and only WebSocket streaming standard. The "v1" and "v2" terminology in SignalK refers to:

- **v1/v2 REST APIs** - Different resource provider patterns (both use the same delta streaming)
- **v1 WebSocket Stream** - The only WebSocket delta endpoint (`/signalk/v1/stream`)
- **SignalK v2 (future)** - A potential future major version with no concrete plans

**This proposal uses the v1 WebSocket streaming infrastructure**, which works with both v1 and v2 REST resource providers.

## Problem Statement

Currently, when resources (charts, routes, waypoints, notes, regions) are added, modified, or deleted on a SignalK server, clients have no way to discover these changes without:

1. **Server restart** - Many plugins require full server restart for changes to become visible
2. **Manual refresh** - Users must manually reload the client application
3. **Inefficient polling** - Clients must repeatedly poll REST endpoints, wasting bandwidth and battery

This creates a poor user experience where:
- Charts uploaded to a server remain invisible to navigation applications until restart
- Routes created in one app don't appear in other connected apps
- Users receive "Please restart SignalK server" messages frequently
- Mobile devices drain battery polling for changes that rarely occur

### Real-World Impact

**Example Scenario:**
1. User uploads new nautical charts via plugin web interface
2. Charts are saved to disk successfully
3. Navigation app (Freeboard SK, WilhelmSK) still shows old chart list
4. User must restart entire SignalK server
5. All active connections interrupted
6. Process takes 30-60 seconds

**User Frustration:** "Why do I need to restart the server? Modern apps update instantly."

## Current Behavior

SignalK already has all the infrastructure needed for real-time updates:
- ✅ WebSocket delta streaming (`/signalk/v1/stream`)
- ✅ Subscription protocol with path wildcards
- ✅ Resources already defined in specification (`schemas/groups/resources.json`)
- ✅ "resources" context supported in delta messages
- ✅ Course API and Autopilot API demonstrate resource-like push updates

**What's Missing:** A standard pattern for resource providers to publish change notifications.

## Proposed Solution

Extend the existing SignalK delta infrastructure to support resource change notifications using the **already-established subscription and delta message patterns**.

### Key Principles

1. **Use existing infrastructure** - No new protocols, leverage WebSocket deltas
2. **Backwards compatible** - Opt-in for providers and clients
3. **Minimal spec changes** - Formalize existing capabilities
4. **Follow proven patterns** - Based on Course API, Autopilot API, Notifications

### Technical Design

#### 1. Delta Message Format

Resource changes use the standard delta format with the `resources` context:

```json
{
  "context": "resources.charts",
  "updates": [
    {
      "source": {
        "label": "charts-provider-simple",
        "type": "plugin.signalk-charts-provider-simple"
      },
      "timestamp": "2025-01-28T10:30:00.000Z",
      "values": [
        {
          "path": "NZ615",
          "value": {
            "identifier": "NZ615",
            "name": "New Zealand - Bay of Islands",
            "description": "NOAA nautical chart",
            "tilemapUrl": "http://localhost:3000/signalk/chart-tiles/NZ615/{z}/{x}/{y}",
            "scale": 50000,
            "bounds": [173.5, -35.5, 174.5, -34.5],
            "chartFormat": "png"
          }
        }
      ],
      "meta": [
        {
          "path": "NZ615",
          "value": {
            "operation": "added",
            "changeTimestamp": "2025-01-28T10:30:00.000Z"
          }
        }
      ]
    }
  ]
}
```

**For deletions**, send `value: null`:

```json
{
  "context": "resources.charts",
  "updates": [{
    "timestamp": "2025-01-28T10:35:00.000Z",
    "values": [{"path": "OLD_CHART", "value": null}],
    "meta": [{"path": "OLD_CHART", "value": {"operation": "deleted"}}]
  }]
}
```

#### 2. Subscription Pattern

Clients subscribe using the existing subscription protocol:

```json
{
  "context": "resources.*",
  "subscribe": [
    {
      "path": "charts.*",
      "policy": "instant",
      "format": "delta"
    }
  ]
}
```

Or subscribe to all resource types:

```json
{
  "subscribe": [
    {
      "path": "resources.*.*",
      "policy": "instant"
    }
  ]
}
```

#### 3. Provider Implementation

Resource providers implement change notifications using `app.handleMessage()`:

```javascript
// When a chart is added/updated
app.handleMessage('charts-provider', {
  context: 'resources.charts',
  updates: [{
    source: {
      label: 'charts-provider-simple',
      type: 'plugin.signalk-charts-provider-simple'
    },
    timestamp: new Date().toISOString(),
    values: [{
      path: chartId,
      value: chartMetadata
    }],
    meta: [{
      path: chartId,
      value: { operation: 'added' }
    }]
  }]
});
```

**Operations:**
- `added` - New resource created
- `updated` - Existing resource modified
- `deleted` - Resource removed (value must be null)

### Supported Resource Types

All existing resource types benefit from this pattern:

| Resource Type | Context | Path Pattern | Use Case |
|---------------|---------|--------------|----------|
| Charts | `resources.charts` | `<chart-id>` | Charts uploaded/deleted |
| Routes | `resources.routes` | `<uuid>` | Routes created/modified in planner |
| Waypoints | `resources.waypoints` | `<uuid>` | Waypoints added during navigation |
| Notes | `resources.notes` | `<uuid>` | User notes/markers added |
| Regions | `resources.regions` | `<uuid>` | Regions defined/updated |

## Benefits

### For Users
- ✅ **Instant updates** - Changes visible immediately in all connected apps
- ✅ **No server restarts** - Upload charts, see them appear instantly
- ✅ **Better UX** - Modern, real-time experience users expect
- ✅ **Multi-device sync** - Edit on tablet, see on phone immediately

### For Developers
- ✅ **Standard pattern** - Consistent across all resource types
- ✅ **Proven infrastructure** - Reuses robust WebSocket delta system
- ✅ **Opt-in** - No breaking changes, implement at your own pace
- ✅ **Simple to add** - Single `app.handleMessage()` call

### For System Performance
- ✅ **Eliminates polling** - Clients no longer need 2-second polling loops
- ✅ **Lower bandwidth** - Push only when changes occur
- ✅ **Better battery life** - Mobile devices sleep instead of polling
- ✅ **Reduced server load** - Fewer redundant HTTP requests

## Comparison to Existing Patterns

This proposal follows the **exact same pattern** already proven in SignalK:

### Course API (Proven Pattern)

The Course API already pushes resource-like updates via deltas:

```javascript
// From signalk-server/src/api/course/index.ts
this.app.handleMessage(
  'courseApi',
  this.buildV1DeltaMsg(paths),
  skVersion
)
```

Course data (routes, waypoints, next point) updates are pushed to subscribed clients **without polling**.

### Autopilot API (Proven Pattern)

The Autopilot API pushes state changes instantly:

```javascript
app.handleMessage('autopilot', {
  updates: [{
    values: [{
      path: 'steering.autopilot.state',
      value: 'enabled'
    }]
  }]
})
```

### Notifications (Proven Pattern)

Alarms and alerts already use delta messages for instant delivery:

```javascript
{
  "context": "vessels.self",
  "updates": [{
    "values": [{
      "path": "notifications.mob",
      "value": {
        "state": "alarm",
        "message": "Man Overboard!"
      }
    }]
  }]
}
```

**This proposal simply applies the same proven pattern to resources.**

## Implementation Plan

### Phase 1: Specification (1-2 weeks)
1. Create RFC issue on `signalk/specification` repository
2. Community discussion and refinement
3. Update schemas:
   - `schemas/groups/resources.json` - Add operation metadata field
   - `schemas/definitions.json` - Define operation enum
4. Add documentation: `mdbook/src/resources_notifications.md`
5. Add test data: `test/data/delta-valid/resource-notifications.json`
6. Submit PR for review

### Phase 2: Server Support (2-4 weeks)
SignalK Server already supports this! No core changes needed - providers can use `app.handleMessage()` today.

Optional enhancements:
1. Helper method: `app.emitResourceChange(type, id, value, operation)`
2. Documentation in Server Plugin API
3. Reference implementation in example plugin

### Phase 3: Provider Adoption (Gradual)
Resource providers update at their own pace:

**Charts Providers:**
- `signalk-charts-provider-simple` (reference implementation)
- `@signalk/charts-plugin`

**Routes/Waypoints:**
- `@signalk/course-provider`
- Route planning plugins

**Notes/Regions:**
- Annotation plugins
- Geofencing plugins

### Phase 4: Client Adoption (Gradual)
Clients add subscription support:

**Navigation Apps:**
- Freeboard SK
- WilhelmSK
- iKommunicate

**Implementation:** ~200-300 lines per client, with graceful fallback to polling if server doesn't support notifications.

## Backwards Compatibility

### 100% Backwards Compatible

**Old providers (no notifications):**
- Continue working unchanged
- Clients fall back to polling
- No degradation

**Old clients (no subscription):**
- Continue working via REST API
- Don't receive push updates
- No breaking changes

**Mixed environments:**
- New provider + old client = Client polls as before
- Old provider + new client = Client polls with ETag optimization
- New provider + new client = Real-time push notifications ✨

### Feature Detection

Clients can detect support:

```javascript
// Check if provider emits resource changes
const supportsNotifications = await fetch('/signalk/v2/api/')
  .then(r => r.json())
  .then(info => info.features?.resourceNotifications);

if (supportsNotifications) {
  subscribeToResourceChanges();
} else {
  startPolling();
}
```

## Alternative Approaches Considered

### 1. ❌ Plugin-Specific WebSocket Endpoints
Each plugin creates its own WebSocket endpoint (e.g., `/signalk/chart-tiles/ws`).

**Rejected because:**
- Duplicates infrastructure
- Not standardized across plugins
- Clients need custom code per plugin
- Doesn't benefit ecosystem

### 2. ❌ Server-Sent Events (SSE)
Use HTTP SSE instead of WebSocket deltas.

**Rejected because:**
- Still plugin-specific
- Adds another protocol to learn
- Doesn't integrate with SignalK subscriptions
- One-way only

### 3. ❌ Webhooks/Callbacks
Clients register callback URLs for notifications.

**Rejected because:**
- Requires clients to run HTTP server
- Firewall/NAT traversal issues
- Not suitable for browser-based clients
- Complex authentication

### 4. ❌ REST Polling with ETags
Optimize polling with conditional requests.

**Partially adopted:**
- Good interim solution (reduces bandwidth 95%)
- Still requires polling (battery drain)
- Latency = poll interval
- Should be used as fallback only

## Reference Implementation

The `signalk-charts-provider-simple` plugin will serve as the reference implementation:

```javascript
// src/index.js

async function refreshChartProviders() {
  const oldCharts = Object.keys(chartProviders);
  const newCharts = await findCharts(chartPath);

  // Determine what changed
  const added = newCharts.filter(id => !oldCharts.includes(id));
  const deleted = oldCharts.filter(id => !newCharts.includes(id));
  const updated = newCharts.filter(id =>
    oldCharts.includes(id) &&
    hasChanged(oldCharts[id], newCharts[id])
  );

  chartProviders = newCharts;

  // Emit notifications
  emitChartChanges(added, 'added');
  emitChartChanges(updated, 'updated');
  emitChartChanges(deleted, 'deleted');
}

function emitChartChanges(charts, operation) {
  charts.forEach(chartId => {
    app.handleMessage('charts-provider', {
      context: 'resources.charts',
      updates: [{
        source: {
          label: 'charts-provider-simple',
          type: 'plugin.signalk-charts-provider-simple'
        },
        timestamp: new Date().toISOString(),
        values: [{
          path: chartId,
          value: operation === 'deleted' ? null : chartProviders[chartId]
        }],
        meta: [{
          path: chartId,
          value: { operation }
        }]
      }]
    });
  });
}

// Trigger refresh after operations
app.post('/upload', async (req, res) => {
  await handleUpload(req);
  await refreshChartProviders(); // Automatically notifies clients
  res.json({ success: true });
});
```

**Code footprint:** ~100 lines for full implementation

## Success Metrics

### User Experience
- **Before:** Upload chart → Wait 30-60s for server restart → Charts appear
- **After:** Upload chart → Charts appear in <2 seconds ✨

### Developer Adoption
- Target: 50% of resource providers support notifications within 6 months
- Target: 75% of major clients support subscriptions within 12 months

### Performance
- Eliminate 90% of polling requests (measured via server logs)
- Reduce mobile battery drain by 15-20% (fewer network operations)

## FAQ

### Q: Why not use the existing Notifications API?
**A:** Notifications are designed for alarms/alerts (safety-critical events). Resources are data entities. Mixing them would conflate semantics. However, the pattern is similar and proven.

### Q: Does this require SignalK Server code changes?
**A:** No! Providers can use `app.handleMessage()` today. Optional helper methods could be added later for convenience.

### Q: What if a provider emits too many updates?
**A:** The subscription `minPeriod` already provides throttling. Additionally, providers should batch changes when appropriate (e.g., bulk uploads).

### Q: How do clients know which resources changed?
**A:** The delta message includes the full resource value (or null for deletions). Clients can compare with cached state or treat as authoritative update.

### Q: What about conflict resolution (multiple sources)?
**A:** SignalK's existing multi-source handling applies. The `source` field identifies the provider. Clients can choose preferred sources or display all.

### Q: Can this work for non-UUID resources (e.g., chart codes)?
**A:** Yes! Chart identifiers are already defined in the spec as 8+ character codes (e.g., "NZ615"). This proposal works with all resource identifier schemes.

## Stakeholder Input

This proposal benefits multiple stakeholders:

### Resource Provider Developers
- Easy to implement using existing API
- Improves user experience significantly
- Demonstrates modern capabilities

### Client Developers
- Eliminates polling complexity
- Better user experience
- Standard pattern across all resources

### End Users
- Instant updates, no restarts
- Multi-app synchronization
- Better battery life on mobile

### SignalK Ecosystem
- Demonstrates delta streaming power
- Competitive with commercial systems
- Attracts developers seeking real-time capabilities

## Prior Art

Similar real-time update systems exist in other ecosystems:

- **Firebase Realtime Database** - Push updates to subscribed clients
- **GraphQL Subscriptions** - WebSocket-based real-time queries
- **MQTT** - Pub/sub for IoT device updates
- **SignalR** - ASP.NET real-time web framework

SignalK already has the infrastructure; this proposal simply formalizes its use for resources.

## Next Steps

1. **Community Feedback** - Discuss this RFC on GitHub issue
2. **Refinement** - Incorporate feedback from maintainers and developers
3. **Specification PR** - Submit formal schema and documentation updates
4. **Reference Implementation** - Complete implementation in charts-provider-simple
5. **Client Support** - Coordinate with Freeboard SK and other clients
6. **Documentation** - Create tutorial for adding notifications to providers

## Conclusion

This proposal adds **zero new infrastructure** to SignalK - it simply formalizes a pattern for using the existing, proven delta streaming system for resource updates.

**Impact:** High value (eliminates server restarts, improves UX)
**Effort:** Low (uses existing infrastructure, opt-in adoption)
**Risk:** Minimal (fully backwards compatible)

Resources should behave like modern cloud-connected data - updating instantly across all devices. This proposal makes that a reality for the SignalK ecosystem.

---

## Appendix A: Complete Example Flow

### Initial State
**Server has 2 charts:**
- NZ615 (New Zealand - Bay of Islands)
- AU302 (Australia - Sydney Harbor)

### User Action
User uploads new chart "US102 (San Francisco Bay)" via plugin web UI.

### Server-Side Flow

```javascript
// 1. Upload completes
POST /signalk/chart-tiles/upload
// Chart file written to disk

// 2. Plugin refreshes chart list
await refreshChartProviders();

// 3. Plugin detects new chart and emits delta
app.handleMessage('charts-provider', {
  context: 'resources.charts',
  updates: [{
    source: {
      label: 'charts-provider-simple',
      type: 'plugin.signalk-charts-provider-simple'
    },
    timestamp: '2025-01-28T10:30:00.000Z',
    values: [{
      path: 'US102',
      value: {
        identifier: 'US102',
        name: 'San Francisco Bay',
        tilemapUrl: 'http://localhost:3000/signalk/chart-tiles/US102/{z}/{x}/{y}',
        bounds: [-122.5, 37.5, -122.0, 38.0],
        chartFormat: 'png'
      }
    }],
    meta: [{
      path: 'US102',
      value: { operation: 'added' }
    }]
  }]
});
```

### Client-Side Flow (Freeboard SK)

```javascript
// 1. Client has WebSocket connection established
const ws = new WebSocket('ws://localhost:3000/signalk/v1/stream');

// 2. Client subscribed to chart changes at startup
ws.send(JSON.stringify({
  context: 'resources.charts',
  subscribe: [{
    path: '*',
    policy: 'instant'
  }]
}));

// 3. Client receives delta message
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.context === 'resources.charts') {
    msg.updates.forEach(update => {
      update.values.forEach(({ path, value }) => {
        if (value === null) {
          // Chart deleted
          removeChart(path);
        } else {
          // Chart added or updated
          addOrUpdateChart(path, value);
        }

        // Check operation metadata
        const meta = update.meta?.find(m => m.path === path);
        if (meta?.value.operation === 'added') {
          showNotification(`New chart available: ${value.name}`);
        }
      });
    });

    // Refresh map display
    refreshMapLayers();
  }
};
```

### Result
**Total time from upload to display: <2 seconds**

Compare to current experience:
- Upload → See "Please restart server" message → Restart → Wait 30-60s → Charts appear

---

## Appendix B: Schema Changes

### resources.json (additions)

```json
{
  "definitions": {
    "resourceMetadata": {
      "type": "object",
      "properties": {
        "operation": {
          "type": "string",
          "enum": ["added", "updated", "deleted"],
          "description": "The operation performed on this resource"
        },
        "changeTimestamp": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp when the change occurred"
        }
      }
    }
  }
}
```

### Test Data

**File:** `test/data/delta-valid/resource-chart-added.json`

```json
{
  "context": "resources.charts",
  "updates": [
    {
      "source": {
        "label": "test-chart-provider",
        "type": "plugin.test"
      },
      "timestamp": "2025-01-28T10:30:00.000Z",
      "values": [
        {
          "path": "TEST001",
          "value": {
            "identifier": "TEST001",
            "name": "Test Chart",
            "chartFormat": "png"
          }
        }
      ],
      "meta": [
        {
          "path": "TEST001",
          "value": {
            "operation": "added",
            "changeTimestamp": "2025-01-28T10:30:00.000Z"
          }
        }
      ]
    }
  ]
}
```

---

## References

- [SignalK Specification - Resources](https://signalk.org/specification/1.7.0/doc/resources.html)
- [SignalK Specification - Delta Format](https://signalk.org/specification/1.7.0/doc/data_model.html#delta-format)
- [SignalK Specification - Subscription Protocol](https://signalk.org/specification/1.7.0/doc/subscription_protocol.html)
- [SignalK Server - Course API](https://github.com/SignalK/signalk-server/blob/master/src/api/course/index.ts)
- [SignalK Charts Provider Simple Plugin](https://github.com/your-repo/signalk-charts-provider-simple)

---

**Discussion:** [Link to GitHub issue once created]
**Implementation:** [Link to reference PR once available]
