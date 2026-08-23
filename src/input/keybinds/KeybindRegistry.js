export const KEYBIND_CATEGORY_ORDER = [
  'Tools',
  'Colors',
  'Selection',
  'History',
  'Canvas Navigation',
  'Panels and Dialogs'
];

export const KEYBIND_ACTIONS = [
  {
    id: 'tool.select',
    label: 'Select tool',
    description: 'Switch to the selection tool.',
    category: 'Tools',
    defaultBinding: 'S'
  },
  {
    id: 'tool.brush',
    label: 'Brush tool',
    description: 'Switch to the current brush mode.',
    category: 'Tools',
    defaultBinding: 'B'
  },
  {
    id: 'tool.line',
    label: 'Line tool',
    description: 'Switch to the line tool.',
    category: 'Tools',
    defaultBinding: 'L'
  },
  {
    id: 'tool.rectangle',
    label: 'Rectangle tool',
    description: 'Switch to the rectangle tool.',
    category: 'Tools',
    defaultBinding: 'R'
  },
  {
    id: 'tool.circle',
    label: 'Circle tool',
    description: 'Switch to the circle tool.',
    category: 'Tools',
    defaultBinding: 'C'
  },
  {
    id: 'tool.text',
    label: 'Text tool',
    description: 'Switch to the text tool.',
    category: 'Tools',
    defaultBinding: 'T'
  },
  {
    id: 'tool.fill',
    label: 'Fill tool',
    description: 'Switch to the fill tool.',
    category: 'Tools',
    defaultBinding: 'F'
  },
  {
    id: 'tool.erase',
    label: 'Erase tool',
    description: 'Switch to the eraser tool.',
    category: 'Tools',
    defaultBinding: 'E'
  },
  {
    id: 'tool.blur',
    label: 'Blur tool',
    description: 'Switch to the blur tool.',
    category: 'Tools',
    defaultBinding: 'U'
  },
  {
    id: 'tool.circleBlur',
    label: 'Circle blur tool',
    description: 'Switch to the circle blur tool.',
    category: 'Tools',
    defaultBinding: 'Y'
  },
  {
    id: 'tool.imageBrush',
    label: 'Image brush tool',
    description: 'Switch to the image brush tool.',
    category: 'Tools',
    defaultBinding: 'G'
  },
  {
    id: 'tool.eyedropper',
    label: 'Eyedropper tool',
    description: 'Switch to the eyedropper tool.',
    category: 'Tools',
    defaultBinding: null
  },
  {
    id: 'tool.pan',
    label: 'Pan tool',
    description: 'Switch to the pan tool.',
    category: 'Tools',
    defaultBinding: 'H'
  },
  {
    id: 'tool.zoom',
    label: 'Zoom tool',
    description: 'Switch to the zoom tool.',
    category: 'Tools',
    defaultBinding: null
  },
  {
    id: 'tool.rotate',
    label: 'Rotate tool',
    description: 'Switch to the rotate tool.',
    category: 'Tools',
    defaultBinding: 'N'
  },
  {
    id: 'tool.temporaryEyedropper',
    label: 'Temporary eyedropper',
    description: 'Hold to temporarily switch to the eyedropper.',
    category: 'Tools',
    defaultBinding: 'Tab',
    defaultSecondaryBinding: 'Alt',
    isHoldAction: true
  },
  {
    id: 'tool.swapColors',
    label: 'Swap colors',
    description: 'Swap the primary and secondary saved colors.',
    category: 'Tools',
    defaultBinding: 'X'
  },
  {
    id: 'color.slot1',
    label: 'Select custom color 1',
    description: 'Select the first saved custom color preset.',
    category: 'Colors',
    defaultBinding: '1'
  },
  {
    id: 'color.slot2',
    label: 'Select custom color 2',
    description: 'Select the second saved custom color preset.',
    category: 'Colors',
    defaultBinding: '2'
  },
  {
    id: 'color.slot3',
    label: 'Select custom color 3',
    description: 'Select the third saved custom color preset.',
    category: 'Colors',
    defaultBinding: '3'
  },
  {
    id: 'color.slot4',
    label: 'Select custom color 4',
    description: 'Select the fourth saved custom color preset.',
    category: 'Colors',
    defaultBinding: '4'
  },
  {
    id: 'color.slot5',
    label: 'Select custom color 5',
    description: 'Select the fifth saved custom color preset.',
    category: 'Colors',
    defaultBinding: '5'
  },
  {
    id: 'color.slot6',
    label: 'Select custom color 6',
    description: 'Select the sixth saved custom color preset.',
    category: 'Colors',
    defaultBinding: '6'
  },
  {
    id: 'color.slot7',
    label: 'Select custom color 7',
    description: 'Select the seventh saved custom color preset.',
    category: 'Colors',
    defaultBinding: '7'
  },
  {
    id: 'color.slot8',
    label: 'Select custom color 8',
    description: 'Select the eighth saved custom color preset.',
    category: 'Colors',
    defaultBinding: '8'
  },
  {
    id: 'selection.copy',
    label: 'Copy selection',
    description: 'Copy the current selection.',
    category: 'Selection',
    defaultBinding: 'Mod+C'
  },
  {
    id: 'selection.cut',
    label: 'Cut selection',
    description: 'Cut the current selection.',
    category: 'Selection',
    defaultBinding: 'Mod+X'
  },
  {
    id: 'selection.paste',
    label: 'Paste selection',
    description: 'Paste from the internal clipboard.',
    category: 'Selection',
    defaultBinding: 'Mod+V'
  },
  {
    id: 'selection.deselect',
    label: 'Deselect',
    description: 'Clear the current selection.',
    category: 'Selection',
    defaultBinding: 'Mod+D'
  },
  {
    id: 'selection.delete',
    label: 'Delete selection',
    description: 'Delete the current selection.',
    category: 'Selection',
    defaultBinding: 'Delete'
  },
  {
    id: 'history.undo',
    label: 'Undo',
    description: 'Undo your last stroke.',
    category: 'History',
    defaultBinding: 'Mod+Z'
  },
  {
    id: 'history.redo',
    label: 'Redo',
    description: 'Redo your last undone stroke.',
    category: 'History',
    defaultBinding: 'Mod+Shift+Z',
    defaultSecondaryBinding: 'Ctrl+Y'
  },
  {
    id: 'history.cancelStroke',
    label: 'Cancel stroke',
    description: 'Cancel your current in-progress stroke.',
    category: 'History'
  },
  {
    id: 'canvas.temporaryPan',
    label: 'Temporary pan',
    description: 'Hold to pan without switching tools.',
    category: 'Canvas Navigation',
    defaultBinding: 'Space',
    isHoldAction: true
  },
  {
    id: 'canvas.temporaryZoom',
    label: 'Temporary zoom mode',
    description: 'Hold to temporarily switch drag interactions into zoom mode.',
    category: 'Canvas Navigation',
    defaultBinding: 'Q',
    isHoldAction: true
  },
  {
    id: 'canvas.zoomIn',
    label: 'Zoom in',
    description: 'Zoom the canvas in around the current cursor position.',
    category: 'Canvas Navigation',
    defaultBinding: 'Equal',
    defaultSecondaryBinding: 'NumpadAdd'
  },
  {
    id: 'canvas.zoomOut',
    label: 'Zoom out',
    description: 'Zoom the canvas out around the current cursor position.',
    category: 'Canvas Navigation',
    defaultBinding: 'Minus',
    defaultSecondaryBinding: 'NumpadSubtract'
  },
  {
    id: 'tool.sizeUp',
    label: 'Increase brush size',
    description: 'Hold to increase the active tool size using the same stepped sizing as wheel changes.',
    category: 'Tools',
    defaultBinding: null,
    isHoldAction: true
  },
  {
    id: 'tool.sizeDown',
    label: 'Decrease brush size',
    description: 'Hold to decrease the active tool size using the same stepped sizing as wheel changes.',
    category: 'Tools',
    defaultBinding: null,
    isHoldAction: true
  },
  {
    id: 'panel.performanceDebug',
    label: 'Performance panel',
    description: 'Toggle the performance debug panel.',
    category: 'Panels and Dialogs',
    defaultBinding: 'Shift+P'
  },
  {
    id: 'app.openSettings',
    label: 'Open settings',
    description: 'Open the app settings dialog.',
    category: 'Panels and Dialogs',
    defaultBinding: 'Mod+Comma'
  }
];

export const KEYBIND_ACTIONS_BY_ID = Object.fromEntries(
  KEYBIND_ACTIONS.map((action) => [action.id, action])
);

export function getDefaultKeybindings() {
  return Object.fromEntries(
    KEYBIND_ACTIONS.map((action) => [
      action.id,
      {
        primary: action.defaultBinding ?? null,
        secondary: action.defaultSecondaryBinding ?? null
      }
    ])
  );
}
