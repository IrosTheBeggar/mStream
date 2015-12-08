#include "node.h"
#include "netroute.h"
#include "nan.h"

#include <errno.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <net/if.h>
#include <net/route.h>

namespace netroute {

using namespace node;
using namespace v8;

bool GetInfo(int family, Handle<Array> result) {
  int mib[6] = { CTL_NET, PF_ROUTE, 0, family, NET_RT_DUMP, 0 };
  size_t size;
  char* addresses;

  // Get buffer size
  if (sysctl(mib, 6, NULL, &size, NULL, 0) == -1) {
    Nan::ThrowError("sysctl failed (get size)");
    return false;
  }

  // Get real addresses
  addresses = reinterpret_cast<char*>(malloc(size));
  if (sysctl(mib, 6, addresses, &size, NULL, 0) == -1) {
    free(addresses);
    Nan::ThrowError("sysctl failed (read)");
    return false;
  }

  // Iterate through received info
  char* current = addresses;
  sockaddr_in* addrs[1024];
  char out[256];

  int flags[4] = { RTA_DST, RTA_GATEWAY, RTA_NETMASK,
                   RTA_GENMASK };
  int indexes[4] = { RTAX_DST, RTAX_GATEWAY, RTAX_NETMASK,
                     RTAX_GENMASK };
  Local<String> keys[4] = {
    Nan::New<String>("destination").ToLocalChecked(),
    Nan::New<String>("gateway").ToLocalChecked(),
    Nan::New<String>("netmask").ToLocalChecked(),
    Nan::New<String>("genmask").ToLocalChecked()
  };

  int i = 0;
  while (current < addresses + size) {
    rt_msghdr* msg = reinterpret_cast<rt_msghdr*>(current);

    // Skip cloned routes
#ifdef RTF_WASCLONED
    if (msg->rtm_flags & RTF_WASCLONED) {
      current += msg->rtm_msglen;
      continue;
    }
#endif

    Local<Object> info = Nan::New<Object>();

    // Copy pointers to socket addresses
    // (each address may be either ip4 or ip6, we should dynamically decide
    //  how far next address is)
    addrs[0] = reinterpret_cast<sockaddr_in*>(msg + 1);
    for (int j = 1; ; j++) {
      size_t prev_size;

      if (addrs[j - 1]->sin_family == AF_INET6) {
        prev_size = sizeof(sockaddr_in6);
      } else {
        prev_size = sizeof(sockaddr_in);
      }

      addrs[j] = reinterpret_cast<sockaddr_in*>(
          reinterpret_cast<char*>(addrs[j - 1]) + prev_size);
      if (reinterpret_cast<char*>(addrs[j]) >= current + msg->rtm_msglen) break;
    }

    // Put every socket address into object
    for (int j = 0; j < 4; j++) {
      if ((msg->rtm_addrs & flags[j]) == 0) continue;

      sockaddr_in* addr = addrs[indexes[j]];
      if (addr->sin_family == AF_INET6) {
        uv_ip6_name(reinterpret_cast<sockaddr_in6*>(addr), out, sizeof(out));
      } else {
        uv_ip4_name(addr, out, sizeof(out));
      }
      info->Set(keys[j], Nan::New<String>(out).ToLocalChecked());
    }

    // Put metrics
    info->Set(Nan::New<String>("mtu").ToLocalChecked(), Nan::New<Number>(msg->rtm_rmx.rmx_mtu));
    info->Set(Nan::New<String>("rtt").ToLocalChecked(), Nan::New<Number>(msg->rtm_rmx.rmx_rtt));
    info->Set(Nan::New<String>("expire").ToLocalChecked(), Nan::New<Number>(msg->rtm_rmx.rmx_expire));

    // Put interface name
    char iface[IFNAMSIZ];
    if_indextoname(msg->rtm_index, iface);
    info->Set(Nan::New<String>("interface").ToLocalChecked(), Nan::New<String>(iface).ToLocalChecked());

    // And put object into resulting array
    result->Set(i, info);
    current += msg->rtm_msglen;
    i++;
  }

  // Finally, free allocated memory
  free(addresses);

  return true;
}

} // namespace netroute
