#include "node.h"
#include "node_object_wrap.h"
#include "netroute.h"
#include "nan.h"

#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <sys/types.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <linux/sockios.h>

namespace netroute {

using namespace node;
using namespace v8;

#define ASSERT(e)                                                             \
  do {                                                                        \
    if ((e)) break;                                                           \
    fprintf(stderr,                                                           \
            "Assertion `" #e "' failed at %s:%d\n", __FILE__, __LINE__);      \
    abort();                                                                  \
  }                                                                           \
  while (0)

unsigned int hex2bin(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  ASSERT(0);
}


void Hex2Bin(char* buf, unsigned int len) {
  unsigned char* p = reinterpret_cast<unsigned char*>(buf);

  for (unsigned int i = 0; i < len; i += 2) {
    unsigned int a = p[i + 0];
    unsigned int b = p[i + 1];
    p[i / 2] = 16 * hex2bin(a) + hex2bin(b);
  }
}


static bool GetRoutesIPv4(Handle<Array> routes) {
  FILE* fp = fopen("/proc/net/route", "r");
  if (fp == NULL) return false;

  char buf[1024];
  char* s = fgets(buf, sizeof(buf), fp); // skip the first line
  ASSERT(s == buf);

  while (!feof(fp)) {
    char iface[256];
    unsigned int dst;
    unsigned int gateway;
    unsigned int flags;
    int refcnt;
    unsigned int use;
    int metric;
    unsigned int mask;
    int mtu;
    unsigned int window;
    unsigned int rtt;

    int nitems = fscanf(fp,
                        "%s %08x %08x %04x %d %u %d %08x %d %u %u\n",
                        iface,
                        &dst,
                        &gateway,
                        &flags,
                        &refcnt,
                        &use,
                        &metric,
                        &mask,
                        &mtu,
                        &window,
                        &rtt);
    if (nitems != 11)
      break;

    char buf[256];
    Local<Object> route = Nan::New<Object>();
    route->Set(Nan::New<String>("interface").ToLocalChecked(),
               Nan::New<String>(iface).ToLocalChecked());
    route->Set(Nan::New<String>("destination").ToLocalChecked(),
               Nan::New<String>(inet_ntop(AF_INET, &dst, buf, sizeof(buf))).ToLocalChecked());
    route->Set(Nan::New<String>("gateway").ToLocalChecked(),
               Nan::New<String>(inet_ntop(AF_INET, &gateway, buf, sizeof(buf))).ToLocalChecked());
    route->Set(Nan::New<String>("flags").ToLocalChecked(), Nan::New<Int32>(flags));
    route->Set(Nan::New<String>("refcnt").ToLocalChecked(), Nan::New<Int32>(refcnt));
    route->Set(Nan::New<String>("use").ToLocalChecked(), Nan::New<Int32>(use));
    route->Set(Nan::New<String>("metric").ToLocalChecked(), Nan::New<Int32>(metric));
    route->Set(Nan::New<String>("netmask").ToLocalChecked(),
               Nan::New<String>(inet_ntop(AF_INET, &mask, buf, sizeof(buf))).ToLocalChecked());
    route->Set(Nan::New<String>("mtu").ToLocalChecked(), Nan::New<Int32>(mtu));
    route->Set(Nan::New<String>("window").ToLocalChecked(), Nan::New<Int32>(window));
    route->Set(Nan::New<String>("rtt").ToLocalChecked(), Nan::New<Int32>(rtt));
    routes->Set(routes->Length(), route);
  }

  fclose(fp);

  return true;
}


static bool GetRoutesIPv6(Handle<Array> routes) {
  FILE* fp = fopen("/proc/net/ipv6_route", "r");
  if (fp == NULL) return false;

  while (!feof(fp)) {
    char dst[256];
    unsigned int dst_len;
    char src[256];
    unsigned int src_len;
    char gateway[256];
    unsigned int flags;
    int metric;
    unsigned int refcnt;
    unsigned int use;
    char iface[256];

    int nitems = fscanf(fp,
                        "%32s %02x %32s %02x %32s %08x %08x %08x %08x %s\n",
                        dst,
                        &dst_len,
                        src,
                        &src_len,
                        gateway,
                        &metric,
                        &refcnt,
                        &use,
                        &flags,
                        iface);
    if (nitems != 10)
      break;

    char buf[256];
    Hex2Bin(dst, 32);
    Hex2Bin(src, 32);
    Hex2Bin(gateway, 32);

    inet_ntop(AF_INET6, &dst, buf, sizeof(buf));
    snprintf(dst, sizeof(dst), "%s/%u", buf, dst_len);
    inet_ntop(AF_INET6, &src, buf, sizeof(buf));
    snprintf(src, sizeof(src), "%s/%u", buf, src_len);
    inet_ntop(AF_INET6, &gateway, buf, sizeof(buf));
    snprintf(gateway, sizeof(gateway), "%s", buf);

    Local<Object> route = Nan::New<Object>();
    route->Set(Nan::New<String>("destination").ToLocalChecked(), Nan::New<String>(dst).ToLocalChecked());
    route->Set(Nan::New<String>("source").ToLocalChecked(), Nan::New<String>(src).ToLocalChecked());
    route->Set(Nan::New<String>("gateway").ToLocalChecked(), Nan::New<String>(gateway).ToLocalChecked());
    route->Set(Nan::New<String>("metric").ToLocalChecked(), Nan::New<Int32>(metric));
    route->Set(Nan::New<String>("refcnt").ToLocalChecked(), Nan::New<Int32>(refcnt));
    route->Set(Nan::New<String>("use").ToLocalChecked(), Nan::New<Int32>(use));
    route->Set(Nan::New<String>("flags").ToLocalChecked(), Nan::New<Int32>(flags));
    route->Set(Nan::New<String>("interface").ToLocalChecked(),
               Nan::New<String>(iface).ToLocalChecked());
    routes->Set(routes->Length(), route);
  }

  fclose(fp);

  return true;
}


bool GetInfo(int family, Handle<Array> result) {
  if (family == AF_INET) return GetRoutesIPv4(result);
  if (family == AF_INET6) return GetRoutesIPv6(result);
  abort();
}

} // namespace netroute
