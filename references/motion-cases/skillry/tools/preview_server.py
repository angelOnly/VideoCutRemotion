import functools,http.server,pathlib,re,shutil,urllib.parse
ROOT=pathlib.Path(__file__).resolve().parent.parent
STUDY=ROOT
class PreviewHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        route=urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        legacy=re.fullmatch(r'/library/cases/([a-zA-Z0-9-]+)-original/index.html',route)
        # 兼容历史详情链接，共用一个详情页，不再保存逐例重复网页。
        if legacy or route=='/library/使用说明.html':
            location='/library/detail.html'+('?case='+legacy.group(1) if legacy else '')
            self.send_response(302);self.send_header('Location',location);self.send_header('Content-Length','0');self.end_headers();return
        super().do_GET()
    def translate_path(self,path):
        route=urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if route.startswith('/library/'):
            # 仅挂载本次研究目录，拒绝跨目录读取。
            target=(STUDY/route[len('/library/'):]).resolve()
            if not target.is_relative_to(STUDY):return str(ROOT/'path-not-allowed')
            return str(target)
        return super().translate_path(path)
    def send_head(self):
        self.byte_range=None
        path=pathlib.Path(self.translate_path(self.path))
        request_range=self.headers.get('Range')
        if path.suffix.lower()!='.mp4' or not path.is_file() or not request_range:
            return super().send_head()
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',request_range.strip())
        size=path.stat().st_size
        if not match or not any(match.groups()):
            self.send_error(416,'Invalid byte range');return None
        start_text,end_text=match.groups()
        if start_text:
            start=int(start_text);end=min(int(end_text) if end_text else size-1,size-1)
        else:
            start=max(0,size-int(end_text));end=size-1
        if start> end or start>=size:
            self.send_response(416);self.send_header('Content-Range',f'bytes */{size}');self.send_header('Content-Length','0');self.end_headers();return None
        stream=path.open('rb');stream.seek(start)
        self.byte_range=(start,end)
        self.send_response(206)
        self.send_header('Content-Type','video/mp4')
        self.send_header('Accept-Ranges','bytes')
        self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length',str(end-start+1))
        self.send_header('Last-Modified',self.date_time_string(path.stat().st_mtime))
        self.end_headers();return stream
    def end_headers(self):
        if self.path.split('?')[0].endswith('.mp4') and self.byte_range is None:
            self.send_header('Accept-Ranges','bytes')
        if not self.path.split('?')[0].endswith('.mp4'):
            self.send_header('Cache-Control','no-store')
        super().end_headers()
    def copyfile(self,source,outputfile):
        # 按请求范围发送，支持播放器拖动进度，不读取范围之外的数据。
        if self.byte_range is None:return shutil.copyfileobj(source,outputfile)
        remaining=self.byte_range[1]-self.byte_range[0]+1
        while remaining:
            chunk=source.read(min(remaining,256*1024))
            if not chunk:break
            outputfile.write(chunk);remaining-=len(chunk)
    def log_message(self,*args):pass
if __name__=='__main__':
    handler=functools.partial(PreviewHandler,directory=str(ROOT))
    server=http.server.ThreadingHTTPServer(('127.0.0.1',8874),handler)
    print('候选预览服务已启动：127.0.0.1:8874',flush=True)
    server.serve_forever()
