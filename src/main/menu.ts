import { Menu, type MenuItemConstructorOptions } from 'electron'

export const OPACITY_PRESETS = [0.1, 0.2, 0.35, 0.5]

interface MenuCallbacks {
  onPickBackground: () => void
  onClearBackground: () => void
  onSetOpacity: (opacity: number) => void
  currentOpacity: () => number
}

/** アプリメニューを構築。背景画像の設定項目を「表示」メニューに置く。
 *  opacity の radio チェックを更新するため、状態が変わるたびに呼び直す。 */
export function buildMenu(cb: MenuCallbacks): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '表示',
      submenu: [
        { label: '背景画像を選択…', click: cb.onPickBackground },
        { label: '背景画像をクリア', click: cb.onClearBackground },
        { type: 'separator' },
        {
          label: '背景の不透明度',
          submenu: OPACITY_PRESETS.map((o) => ({
            label: `${Math.round(o * 100)}%`,
            type: 'radio' as const,
            checked: Math.abs(cb.currentOpacity() - o) < 0.001,
            click: () => cb.onSetOpacity(o)
          }))
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
