#include "netroute.h"
#include "node.h"
#include "nan.h"

#include <errno.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <net/if.h>
#include <net/route.h>

namespace netroute {

using namespace v8;
using namespace node;

static NAN_METHOD(GetInfo) {
  Nan::EscapableHandleScope scope;

  Local<Object> result = Nan::New<Object>();
  Local<Array> ipv4 = Nan::New<Array>();
  Local<Array> ipv6 = Nan::New<Array>();

  if (!GetInfo(AF_INET, ipv4))
    return;
  if (!GetInfo(AF_INET6, ipv6))
    return;

  result->Set(Nan::New<String>("IPv4").ToLocalChecked(), ipv4);
  result->Set(Nan::New<String>("IPv6").ToLocalChecked(), ipv6);

  info.GetReturnValue().Set(result);
}


static void Init(Handle<Object> target) {
  Nan::HandleScope scope;

  Nan::SetMethod(target, "getInfo", GetInfo);
}

NODE_MODULE(netroute, Init);

} // namespace netroute
