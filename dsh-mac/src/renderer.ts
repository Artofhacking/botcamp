import { installChiefPanel } from './client/chief-panel.ts'

declare const __DSH_VERSION__: string

installChiefPanel({ fill: true, version: __DSH_VERSION__ })
