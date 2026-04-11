import '../css/main.scss';

import { mount } from 'svelte';

import Chat from '../ui/svelte/Chat.svelte';
import { isTauriDesktop } from '../platform/desktop.js';
import { initChatPopoutClient, sendChatPopoutAction } from '../platform/chatPopoutBridge.js';

if (!isTauriDesktop()) {
  window.location.replace('/go/');
}

document.documentElement.dataset.chatPopout = 'true';
document.body.dataset.chatPopout = 'true';

const chat = mount(Chat, {
  target: document.getElementById('app'),
  props: {
    isPopout: true,
    onSend: (message) => sendChatPopoutAction({ type: 'send', message }),
    onStaffSend: (message) => sendChatPopoutAction({ type: 'staff-send', message }),
    onStaffSendImage: (imageData) => sendChatPopoutAction({ type: 'staff-send-image', imageData }),
    onDM: (message, recipientId) => sendChatPopoutAction({ type: 'dm-send', message, recipientId }),
    onSendImage: (imageData, recipientId) => sendChatPopoutAction({ type: 'send-image', imageData, recipientId }),
    onReact: (payload) => sendChatPopoutAction({ type: 'react', payload })
  }
});

const cleanup = initChatPopoutClient({ component: chat });

window.addEventListener('beforeunload', () => {
  cleanup?.();
});
