#ifndef NETROUTE_H_
#define NETROUTE_H_

#include "v8.h"

namespace netroute {

bool GetInfo(int family, v8::Handle<v8::Array> result);

} // namespace netroute

#endif // NETROUTE_H_
