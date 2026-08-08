'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agonAPI', {
  // Config
  getConfig:    ()    => ipcRenderer.invoke('get-config'),
  saveConfig:   (cfg) => ipcRenderer.invoke('save-config', cfg),
  // Impressoras
  getPrinters:  ()    => ipcRenderer.invoke('get-printers'),
  // Pedidos
  getRecentOrders: () => ipcRenderer.invoke('get-recent-orders'),
  reprintOrder: (order) => ipcRenderer.invoke('reprint-order', order),
  // Status
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),
  // Autostart
  getAutostart: ()       => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enable) => ipcRenderer.invoke('set-autostart', enable),
  // Log
  openLog: () => ipcRenderer.invoke('open-log'),

  // Eventos do main → renderer
  onStatusUpdate: (cb) => ipcRenderer.on('status-update', (_, d) => cb(d)),
  onNewOrder:     (cb) => ipcRenderer.on('new-order',     (_, d) => cb(d)),
});
