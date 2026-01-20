/**
 * Chat manager for handling chat functionality
 */
export class Chat {
  constructor(options = {}) {
    this.container = null;
    this.messageList = null;
    this.messagesContainer = null;
    this.input = null;
    this.sendButton = null;
    this.visible = false;
    this.onSend = options.onSend || null;
  }

  init() {
    this.container = document.getElementById('chat');
    this.messageList = document.getElementById('messageList');
    this.messagesContainer = document.getElementById('chatMessages');
    this.input = document.getElementById('chatInput');
    this.sendButton = document.getElementById('sendMessageBtn');

    this.container.style.display = 'none';
    this.makeDraggable();
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.sendButton.addEventListener('click', () => {
      this.handleSend();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.handleSend();
      }
    });
  }

  handleSend() {
    const message = this.input.value.trim();
    if (message && this.onSend) {
      this.onSend(message);
      this.input.value = '';
    }
  }

  addMessage(message, user) {
    if (!message) return;

    const li = document.createElement('li');
    li.className = 'message';

    if (user === 'system') {
      li.className = 'system message';
      li.innerHTML = `<span class='messageText'>${message}</span>`;
    } else {
      const username = user.username || 'Anon';
      li.innerHTML = `<span class='messageName'>${username}: </span><span class='messageText'>${message}</span>`;
    }

    this.messageList.appendChild(li);
    this.scrollToBottom();
  }

  addSystemMessage(message) {
    this.addMessage(message, 'system');
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
  }

  show() {
    this.visible = true;
    this.container.style.display = 'block';
  }

  hide() {
    this.visible = false;
    this.container.style.display = 'none';
  }

  resetPosition() {
    const containerWidth = document.getElementById('boardContainer').clientWidth;
    this.container.style.top = '30px';
    this.container.style.left = `${containerWidth - 200}px`;
  }

  makeDraggable() {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    this.container.addEventListener('mousedown', (e) => {
      if (e.target === this.container || e.target.parentElement === this.container) {
        isDragging = true;
        offsetX = e.clientX - this.container.offsetLeft;
        offsetY = e.clientY - this.container.offsetTop;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        this.container.style.left = `${e.clientX - offsetX}px`;
        this.container.style.top = `${e.clientY - offsetY}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }
}
