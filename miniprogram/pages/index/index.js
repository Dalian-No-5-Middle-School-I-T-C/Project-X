Page({
  data: {
    serverUrl: '',
    token: ''
  },
  
  onLoad() {
    const savedUrl = wx.getStorageSync('px_server_url');
    if (savedUrl) {
      this.setData({ serverUrl: savedUrl });
    }
  },
  
  onServerUrlInput(e) {
    this.setData({ serverUrl: e.detail.value });
  },
  
  onTokenInput(e) {
    this.setData({ token: e.detail.value });
  },
  
  enterSystem() {
    let url = this.data.serverUrl.trim();
    const token = this.data.token.trim();
    
    if (!url) {
      wx.showToast({ title: '请输入服务器地址', icon: 'none' });
      return;
    }
    
    url = url.replace(/\/$/, '');
    wx.setStorageSync('px_server_url', url);
    
    const params = [];
    params.push('api_base=' + encodeURIComponent(url));
    if (token) {
      params.push('token=' + encodeURIComponent(token));
    }
    
    const webUrl = url + '/Grade-Analysis-System-mobile.html?' + params.join('&');
    
    wx.navigateTo({
      url: '/pages/webview/webview?url=' + encodeURIComponent(webUrl)
    });
  },
  
  enterDemo() {
    let url = this.data.serverUrl.trim() || 'https://demo.example.com';
    url = url.replace(/\/$/, '');
    
    const webUrl = url + '/Grade-Analysis-System-mobile.html?demo=1';
    
    wx.navigateTo({
      url: '/pages/webview/webview?url=' + encodeURIComponent(webUrl)
    });
  }
});
