'use strict';
const{contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('voiceQA',{report(value){if(JSON.stringify(value).length>20000)throw Error('QA result too large.');ipcRenderer.send('raw-voice-qa',value);}});
