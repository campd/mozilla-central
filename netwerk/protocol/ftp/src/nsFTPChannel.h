/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 *
 * The contents of this file are subject to the Netscape Public License
 * Version 1.0 (the "NPL"); you may not use this file except in
 * compliance with the NPL.  You may obtain a copy of the NPL at
 * http://www.mozilla.org/NPL/
 *
 * Software distributed under the NPL is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the NPL
 * for the specific language governing rights and limitations under the
 * NPL.
 *
 * The Initial Developer of this code under the NPL is Netscape
 * Communications Corporation.  Portions created by Netscape are
 * Copyright (C) 1998 Netscape Communications Corporation.  All Rights
 * Reserved.
 */

// ftp implementation header

#ifndef nsFTPChannel_h___
#define nsFTPChannel_h___

#include "nsIFTPChannel.h"
#include "nsIStreamListener.h"
#include "nsIThread.h"
#include "nsIURI.h"
#include "nsString2.h"
#include "nsIEventQueue.h"

class nsIEventSinkGetter;
class nsIProgressEventSink;

class nsFTPChannel : public nsIFTPChannel,
                     public nsIStreamListener {
public:
    NS_DECL_ISUPPORTS

    // nsIRequest methods:
    NS_IMETHOD Cancel();
    NS_IMETHOD Suspend();
    NS_IMETHOD Resume();

    // nsIChannel methods:
    NS_IMETHOD GetURI(nsIURI * *aURL);
    NS_IMETHOD OpenInputStream(PRUint32 startPosition, PRInt32 readCount, nsIInputStream **_retval);
    NS_IMETHOD OpenOutputStream(PRUint32 startPosition, nsIOutputStream **_retval);
    NS_IMETHOD AsyncRead(PRUint32 startPosition, PRInt32 readCount,
                         nsISupports *ctxt,
                         nsIEventQueue *eventQueue,
                         nsIStreamListener *listener);
    NS_IMETHOD AsyncWrite(nsIInputStream *fromStream,
                          PRUint32 startPosition,
                          PRInt32 writeCount,
                          nsISupports *ctxt,
                          nsIEventQueue *eventQueue,
                          nsIStreamObserver *observer);
    NS_IMETHOD GetLoadAttributes(PRUint32 *aLoadAttributes);
    NS_IMETHOD SetLoadAttributes(PRUint32 aLoadAttributes);
    NS_IMETHOD GetContentType(char * *aContentType);

    // nsIFTPChannel methods:
    NS_IMETHOD Get(void);
    NS_IMETHOD Put(void);
    NS_IMETHOD SetStreamListener(nsIStreamListener* aListener);

    // nsIStreamObserver methods:
    NS_IMETHOD OnStartBinding(nsISupports* context);
    NS_IMETHOD OnStopBinding(nsISupports* context,
                             nsresult aStatus,
                             const PRUnichar* aMsg);
    NS_IMETHOD OnStartRequest(nsISupports *ctxt);
    NS_IMETHOD OnStopRequest(nsISupports *ctxt,
                             nsresult status,
                             const PRUnichar *errorMsg);

    // nsIStreamListener methods:
    NS_IMETHOD OnDataAvailable(nsISupports* context,
                               nsIInputStream *aIStream, 
                               PRUint32 aSourceOffset,
                               PRUint32 aLength);

    // nsFTPChannel methods:
    nsFTPChannel();
    virtual ~nsFTPChannel();

    // Define a Create method to be used with a factory:
    static NS_METHOD
    Create(nsISupports* aOuter, const nsIID& aIID, void* *aResult);
    
    nsresult Init(const char* verb, nsIURI* uri, nsIEventSinkGetter* getter,
                  nsIEventQueue* queue);

protected:
    nsIURI*                 mUrl;
    nsIEventQueue*          mEventQueue;
    nsIProgressEventSink*   mEventSink;

    PRBool                  mConnected;
    nsIStreamListener*      mListener;
    PRUint32                mLoadAttributes;
};

#endif /* nsFTPChannel_h___ */
