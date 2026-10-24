# Flux solaire

Shows the energy flows of the house in Gladys: panels → house, panels →
Urban Solar virtual battery, virtual battery → house.

## Requirements

The **flux-solaire service** runs on your network (container
`ghcr.io/midsnipee/ema:flux-solaire`, e.g. on a NAS). It reads in Gladys the
power of the APsystems ECU and the Ecojoko instant power, and keeps the
estimated balance of the virtual battery. This integration reads that
service, nothing else.

## Configuration

1. **flux-solaire service address**: `http://<NAS>:8085`.
2. **Animated page** (optional): an **https** address of the animated page,
   for a "See the animation" button. Gladys only opens https links.
3. Save, click **Test the service**, then open **Discovery** and create the
   **Flux solaire** device.
4. On the dashboard, add the **Solar flows** widget.

## The device

| Feature | Unit |
|---|---|
| Solar production | W |
| House consumption | W |
| Solar used on site | W |
| Injection to the virtual battery | W |
| Drawn from the virtual battery | W |
| Estimated virtual battery balance | kWh |
| Self-consumption | % |

Usable in scenes (e.g. injection > 1,000 W → start the washing machine). The
balance is an estimate kept by the service: correct it from the service
page.

## The widget

Six live tiles, the picture of the flows (the arrows' width follows the
watts; dots run along the arrows, faster as the power rises: an animated WebP image) and when
the last readings were made.

## Troubleshooting

- **"The flux-solaire service does not answer"**: wrong address or the
  container is stopped. Open the address in a browser.
- **"le service n'arrive pas à lire Gladys"**: see the flux-solaire
  container logs (Gladys credentials, features not found).
- **The tiles show "—"**: the device is not created yet (Discovery).
