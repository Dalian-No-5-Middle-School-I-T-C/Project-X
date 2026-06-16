Page({
  data: {
    url: ''
  },
  
  onLoad(options) {
    if (options.url) {
      this.setData({ url: decodeURIComponent(options.url) });
    } else {
      wx.showToast({ title: '缺少网页地址', icon: 'none' });
      wx.navigateBack();
    }
  },
  
  onMessage(e) {
    console.log('收到网页消息:', e.detail);
    const data = e.detail.data && e.detail.data[0];
    if (data) {
      if (data.event === 'pageReady') {
        wx.setNavigationBarTitle({
          title: data.role === 'student' ? '学生成绩' : '教师控制台'
        });
      }
    }
  }
});
