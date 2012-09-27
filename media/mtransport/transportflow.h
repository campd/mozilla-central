/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// Original author: ekr@rtfm.com

#ifndef transportflow_h__
#define transportflow_h__

#include <deque>
#include <string>

#include "nscore.h"
#include "nsISupportsImpl.h"
#include "transportlayer.h"
#include "m_cpp_utils.h"

// A stack of transport layers acts as a flow.
// Generally, one reads and writes to the top layer.
class TransportFlow : public sigslot::has_slots<> {
 public:
  TransportFlow() : id_("(anonymous)") {}
  TransportFlow(const std::string id) : id_(id) {}
  ~TransportFlow();

  const std::string& id() const { return id_; }
  // Layer management
  nsresult PushLayer(TransportLayer *layer);
  TransportLayer *top() const;
  TransportLayer *GetLayer(const std::string& id) const;

  // Wrappers for whatever TLayer happens to be the top layer
  // at the time. This way you don't need to do top()->Foo().
  TransportLayer::State state(); // Current state
  TransportResult SendPacket(const unsigned char *data, size_t len);

  // State has changed. Reflects the top flow.
  sigslot::signal2<TransportFlow *, TransportLayer::State>
    SignalStateChange;

  // Data received on the flow
  sigslot::signal3<TransportFlow*, const unsigned char *, size_t>
    SignalPacketReceived;

  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(TransportFlow)

 private:
  DISALLOW_COPY_ASSIGN(TransportFlow);

  void StateChange(TransportLayer *layer, TransportLayer::State state);
  void PacketReceived(TransportLayer* layer, const unsigned char *data,
      size_t len);
  
  std::string id_;
  std::deque<TransportLayer *> layers_;
};

#endif
