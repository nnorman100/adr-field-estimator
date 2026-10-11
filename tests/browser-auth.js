(()=>{
  const read=(key,fallback)=>JSON.parse(sessionStorage.getItem(key)||'null')??fallback;
  const write=(key,value)=>sessionStorage.setItem(key,JSON.stringify(value));
  const fail=code=>Object.assign(Error(code),{code});
  const listeners=[];window.__testEmails=[];
  // Accounts persist in sessionStorage so reloads keep the synthetic password user. Its uid is the email's local part.
  window.__testVerify=email=>{const accounts=read('synthetic-accounts',{});accounts[email].verified=true;write('synthetic-accounts',accounts);};
  const passwordUser=email=>{
    const user={uid:email.split('@')[0],email,providerData:[{providerId:'password'}],emailVerified:!!read('synthetic-accounts',{})[email]?.verified,getIdToken:async()=>user.uid,
      reload:async()=>{user.emailVerified=!!read('synthetic-accounts',{})[email]?.verified;},
      sendEmailVerification:async()=>{window.__testEmails.push({type:'verify',email});}};
    return user;
  };
  const initial=()=>{
    if(sessionStorage.getItem('synthetic-signed-out'))return null;
    const uid=sessionStorage.getItem('synthetic-uid')||'test-owner-'+crypto.randomUUID();sessionStorage.setItem('synthetic-uid',uid);
    const email=Object.keys(read('synthetic-accounts',{})).find(address=>address.split('@')[0]===uid);
    return email?passwordUser(email):{uid,email:'synthetic@example.invalid',emailVerified:true,providerData:[{providerId:'google.com'}],getIdToken:async()=>uid};
  };
  const change=user=>{
    auth.currentUser=user;
    if(user){sessionStorage.removeItem('synthetic-signed-out');sessionStorage.setItem('synthetic-uid',user.uid);}else sessionStorage.setItem('synthetic-signed-out','1');
    listeners.forEach(fn=>fn(user));return {user};
  };
  const auth={currentUser:initial(),setPersistence:async()=>{},
    onAuthStateChanged:fn=>{listeners.push(fn);window.__testAuthChanged=fn;return fn(auth.currentUser);},
    signInWithPopup:async()=>{},signOut:async()=>change(null),
    signInWithEmailAndPassword:async(email,password)=>{
      const account=read('synthetic-accounts',{})[email];
      if(!account)throw fail('auth/user-not-found');if(account.password!==password)throw fail('auth/wrong-password');
      return change(passwordUser(email));
    },
    createUserWithEmailAndPassword:async(email,password)=>{
      const accounts=read('synthetic-accounts',{});
      if(accounts[email])throw fail('auth/email-already-in-use');if(password.length<6)throw fail('auth/weak-password');
      accounts[email]={password,verified:false};write('synthetic-accounts',accounts);return change(passwordUser(email));
    },
    sendPasswordResetEmail:async email=>{window.__testEmails.push({type:'reset',email});}};
  const factory=()=>auth;factory.Auth={Persistence:{LOCAL:'local'}};
  window.firebase={initializeApp:()=>{},auth:factory};
  window.firebase.auth.GoogleAuthProvider=class{setCustomParameters(){}};
})();
