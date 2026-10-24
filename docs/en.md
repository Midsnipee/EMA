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

The diagram of the flux-solaire page: panels, house and virtual battery, dots running along the arrows (faster as the power rises), the values on the arrows, and on the right the four readings (production, consumption, Ecojoko, self-consumption) with the time of the last reading. It is an animated WebP image: set **Theme of the picture** (dark or light) in the widget settings to match the Gladys theme. On a PC, put the widget in a narrow dashboard column so it does not take the whole width.

## Troubleshooting

- **"The flux-solaire service does not answer"**: wrong address or the
  container is stopped. Open the address in a browser.
- **"le service n'arrive pas à lire Gladys"**: see the flux-solaire
  container logs (Gladys credentials, features not found).
